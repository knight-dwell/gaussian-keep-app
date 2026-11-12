package dev.gaussian.keep;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * gaussian_keep on Android: the Material web UI (assets/www) in a WebView,
 * plus native pieces the web side asks for through the "Android" bridge:
 * private file storage, preferences, fetching web pages (citations),
 * exact reminders with notifications, opening links, picking images.
 */
public class MainActivity extends Activity {
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingShare;
    private static final int PICK_FILE = 41;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#111318"));
        web = new WebView(this);
        root.addView(web);
        setContentView(root);

        // edge-to-edge (Android 15): keep the page clear of the status / navigation bars
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                         insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);
        web.setBackgroundColor(Color.parseColor("#111318"));
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("file".equals(u.getScheme())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));   // links open in the browser
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (pendingShare != null) { deliverShare(pendingShare); pendingShare = null; }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType(p.getAcceptTypes().length > 0 && !p.getAcceptTypes()[0].isEmpty() ? p.getAcceptTypes()[0] : "*/*");
                startActivityForResult(Intent.createChooser(pick, "Choose a file"), PICK_FILE);
                return true;
            }
        });
        web.loadUrl("file:///android_asset/www/index.html");

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null) { if (web.getUrl() != null && web.getProgress() == 100) deliverShare(text); else pendingShare = text; }
        }
    }

    private void deliverShare(String text) {
        web.evaluateJavascript("window.onShared && window.onShared(" + JSONObject.quote(text) + ")", null);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK_FILE && fileCallback != null) {
            Uri[] r = (res == RESULT_OK && data != null && data.getData() != null) ? new Uri[]{data.getData()} : null;
            fileCallback.onReceiveValue(r);
            fileCallback = null;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.evaluateJavascript("window.onAppPause && window.onAppPause()", null);   // flush + sync
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.goBack ? String(window.goBack()) : 'false'", r -> {
            if (!"\"true\"".equals(r)) MainActivity.super.onBackPressed();
        });
    }

    // ── everything the web side can ask for ───────────────────────────────────
    public class Bridge {
        private File base() { File f = new File(getFilesDir(), "repo"); f.mkdirs(); return f; }

        private File safe(String rel) {
            File f = new File(base(), rel);
            try {
                if (!f.getCanonicalPath().startsWith(base().getCanonicalPath() + File.separator))
                    throw new SecurityException("path outside storage");
            } catch (java.io.IOException e) { throw new SecurityException(e); }
            return f;
        }

        @JavascriptInterface public String readFile(String rel) {
            try { return new String(readAll(new FileInputStream(safe(rel))), StandardCharsets.UTF_8); }
            catch (Exception e) { return null; }
        }

        @JavascriptInterface public String readBase64(String rel) {
            try { return Base64.encodeToString(readAll(new FileInputStream(safe(rel))), Base64.NO_WRAP); }
            catch (Exception e) { return null; }
        }

        @JavascriptInterface public boolean writeFile(String rel, String text) {
            return writeBytes(rel, text.getBytes(StandardCharsets.UTF_8));
        }

        @JavascriptInterface public boolean writeBase64(String rel, String b64) {
            return writeBytes(rel, Base64.decode(b64, Base64.DEFAULT));
        }

        private boolean writeBytes(String rel, byte[] data) {
            try {
                File f = safe(rel);
                f.getParentFile().mkdirs();
                File tmp = new File(f.getPath() + ".tmp");
                try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); }
                return tmp.renameTo(f);
            } catch (Exception e) { return false; }
        }

        @JavascriptInterface public boolean deleteFile(String rel) {
            try { return safe(rel).delete(); } catch (Exception e) { return false; }
        }

        @JavascriptInterface public String listFiles() {
            JSONArray out = new JSONArray();
            walk(base(), "", out);
            return out.toString();
        }

        private void walk(File dir, String prefix, JSONArray out) {
            File[] kids = dir.listFiles();
            if (kids == null) return;
            for (File k : kids) {
                String rel = prefix.isEmpty() ? k.getName() : prefix + "/" + k.getName();
                if (k.isDirectory()) walk(k, rel, out); else if (!rel.endsWith(".tmp")) out.put(rel);
            }
        }

        @JavascriptInterface public String getPref(String key) {
            return prefs().getString(key, null);
        }

        @JavascriptInterface public void setPref(String key, String value) {
            if (value == null) prefs().edit().remove(key).apply(); else prefs().edit().putString(key, value).apply();
        }

        private SharedPreferences prefs() { return getSharedPreferences("keep", MODE_PRIVATE); }

        /** GET a web page natively (no CORS) for the citation extractor. Runs on the bridge thread. */
        @JavascriptInterface public String fetchUrl(String url) {
            JSONObject r = new JSONObject();
            try {
                Uri u = Uri.parse(url);
                if (!"https".equals(u.getScheme()) && !"http".equals(u.getScheme())) throw new IllegalArgumentException("only http(s)");
                // never reach into the phone itself or the local network
                for (java.net.InetAddress a : java.net.InetAddress.getAllByName(u.getHost()))
                    if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress())
                        throw new IllegalArgumentException("local address");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(12000);
                c.setReadTimeout(15000);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) gaussian_keep/1.0");
                c.setRequestProperty("Accept", "text/html,application/xhtml+xml");
                int code = c.getResponseCode();
                InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
                byte[] body = in == null ? new byte[0] : readLimited(in, 3_000_000);
                r.put("status", code);
                r.put("url", c.getURL().toString());
                r.put("body", new String(body, StandardCharsets.UTF_8));
            } catch (Exception e) {
                try { r.put("status", 0); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
            }
            return r.toString();
        }

        @JavascriptInterface public void scheduleReminder(String id, double whenMs, String text) {
            ReminderReceiver.schedule(MainActivity.this, id, (long) whenMs, text);
        }

        @JavascriptInterface public void cancelReminder(String id) {
            ReminderReceiver.cancel(MainActivity.this, id);
        }

        @JavascriptInterface public void openUrl(String url) {
            runOnUiThread(() -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
        }

        @JavascriptInterface public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
            catch (Exception e) { return "?"; }
        }
    }

    static byte[] readAll(InputStream in) throws java.io.IOException {
        return readLimited(in, Integer.MAX_VALUE);
    }

    static byte[] readLimited(InputStream in, int max) throws java.io.IOException {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0 && out.size() < max) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }
}
