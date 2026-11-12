package dev.gaussian.keep;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONObject;

import java.util.Iterator;

/** Exact reminders: scheduled from the web side, shown as notifications, kept across reboots. */
public class ReminderReceiver extends BroadcastReceiver {
    static final String CHANNEL = "reminders";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String id = intent.getStringExtra("id"), text = intent.getStringExtra("text");
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH));
        PendingIntent open = PendingIntent.getActivity(ctx, 0, new Intent(ctx, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Reminder")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setColor(0xFF2B4678)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build();
        nm.notify(id == null ? 0 : id.hashCode(), n);
        store(ctx).edit().remove(id).apply();
    }

    static SharedPreferences store(Context ctx) { return ctx.getSharedPreferences("alarms", Context.MODE_PRIVATE); }

    static PendingIntent pending(Context ctx, String id, String text) {
        Intent i = new Intent(ctx, ReminderReceiver.class).putExtra("id", id).putExtra("text", text);
        i.setAction("dev.gaussian.keep.REMIND." + id);
        return PendingIntent.getBroadcast(ctx, id.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void schedule(Context ctx, String id, long when, String text) {
        if (when <= System.currentTimeMillis()) return;
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        PendingIntent pi = pending(ctx, id, text);
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        try {
            store(ctx).edit().putString(id, new JSONObject().put("when", when).put("text", text).toString()).apply();
        } catch (Exception ignored) { }
    }

    static void cancel(Context ctx, String id) {
        ctx.getSystemService(AlarmManager.class).cancel(pending(ctx, id, ""));
        store(ctx).edit().remove(id).apply();
    }

    /** after a reboot: schedule everything that is still in the future */
    static void rescheduleAll(Context ctx) {
        for (String id : store(ctx).getAll().keySet()) {
            try {
                JSONObject o = new JSONObject(store(ctx).getString(id, "{}"));
                schedule(ctx, id, o.getLong("when"), o.getString("text"));
            } catch (Exception ignored) { }
        }
    }
}
