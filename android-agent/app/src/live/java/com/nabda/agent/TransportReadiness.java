package com.nabda.agent;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;

import java.util.List;

/** Fails closed before the phone claims more queue work. */
public final class TransportReadiness {
    private TransportReadiness() {}

    public static void validate(Context context) {
        requireSelectedSubscriptionId(context);
    }

    public static int requireSelectedSubscriptionId(Context context) {
        AgentStateStore state = new AgentStateStore(context);
        if (!BuildConfig.LIVE_SMS_COMPILED_IN
                || !state.isLiveConfirmed()
                || context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED
                || context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Live SMS requires build opt-in, confirmation, and phone permissions.");
        }
        int subscriptionId = new SecureSettings(context).loadSelectedSubscriptionId();
        SubscriptionManager subscriptions = context.getSystemService(SubscriptionManager.class);
        List<SubscriptionInfo> active = subscriptions == null ? null : subscriptions.getActiveSubscriptionInfoList();
        if (active != null) {
            for (SubscriptionInfo info : active) {
                if (info.getSubscriptionId() == subscriptionId) return subscriptionId;
            }
        }
        throw new IllegalStateException("The selected SIM is not active. Stop the agent and choose an active SIM.");
    }
}
