package com.nabda.agent;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.SmsManager;

import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Compiled only for an explicitly enabled live release flavor. */
public final class MessageDispatcherFactory {
    private MessageDispatcherFactory() {}

    public static MessageDispatcher create() {
        return (context, message) -> {
            AgentStateStore state = new AgentStateStore(context);
            if (!BuildConfig.LIVE_SMS_COMPILED_IN
                    || !state.isLiveConfirmed()
                    || context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
                throw new SecurityException("Live SMS requires build opt-in, in-app confirmation, and SEND_SMS permission.");
            }

            SmsManager manager = context.getSystemService(SmsManager.class);
            if (manager == null) {
                throw new IllegalStateException("No SMS service is available on this device.");
            }
            ArrayList<String> parts = manager.divideMessage(message.body);
            if (parts.size() != 1) {
                throw new IllegalArgumentException("Nabda live transport accepts one SMS segment only.");
            }
            int partCount = 1;
            String operationId = UUID.randomUUID().toString();
            String action = context.getPackageName() + ".SMS_SENT." + operationId;
            CountDownLatch sentResults = new CountDownLatch(partCount);
            AtomicInteger firstFailure = new AtomicInteger(Activity.RESULT_OK);
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    int result = getResultCode();
                    if (result != Activity.RESULT_OK) {
                        firstFailure.compareAndSet(Activity.RESULT_OK, result);
                    }
                    sentResults.countDown();
                }
            };
            if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(receiver, new IntentFilter(action), Context.RECEIVER_NOT_EXPORTED);
            } else {
                context.registerReceiver(receiver, new IntentFilter(action));
            }
            try {
                manager.sendTextMessage(
                        message.to,
                        null,
                        message.body,
                        sentIntent(context, action, operationId, 0),
                        null);
                if (!sentResults.await(60, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Timed out waiting for the Android SMS sent result.");
                }
                if (firstFailure.get() != Activity.RESULT_OK) {
                    throw new IllegalStateException("Android SMS transport failed with result " + firstFailure.get() + ".");
                }
                return DispatchResult.sent("android_" + operationId);
            } finally {
                context.unregisterReceiver(receiver);
            }
        };
    }

    private static PendingIntent sentIntent(
            Context context,
            String action,
            String operationId,
            int partIndex) {
        Intent intent = new Intent(action)
                .setPackage(context.getPackageName())
                .putExtra("operation_id", operationId)
                .putExtra("part_index", partIndex);
        int requestCode = 31 * operationId.hashCode() + partIndex;
        return PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
