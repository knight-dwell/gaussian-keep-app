package dev.gaussian.keep;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarms are forgotten when the phone restarts; put the pending reminders back. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) ReminderReceiver.rescheduleAll(ctx);
    }
}
