package com.nabda.agent;

import android.app.Activity;
import android.view.View;
import android.widget.CheckBox;

/** Simulation flavor has no carrier permission or confirmation code at all. */
public final class TransportGate {
    private final CheckBox consentView;
    private final AgentStateStore stateStore;

    public TransportGate(Activity activity, CheckBox consentView, AgentStateStore stateStore) {
        this.consentView = consentView;
        this.stateStore = stateStore;
    }

    public void initialize() {
        consentView.setVisibility(View.GONE);
        consentView.setChecked(false);
        stateStore.setLiveConfirmed(false);
    }

    public void confirmThenRun(Runnable action) {
        action.run();
    }

    public void onRequestPermissionsResult(int requestCode, int[] grantResults) {
        // The simulation flavor requests no carrier permission.
    }

    public void onStopped() {
        stateStore.setLiveConfirmed(false);
        consentView.setChecked(false);
    }
}
