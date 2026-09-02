package com.nabda.agent;

import android.app.Activity;
import android.view.View;
import android.widget.Spinner;

/** Simulation has no carrier-SIM access. */
public final class SimSelectionController {
    private final View section;

    public SimSelectionController(Activity activity, View section, Spinner spinner, SecureSettings settings) {
        this.section = section;
    }

    public void initialize() {
        section.setVisibility(View.GONE);
    }

    public void refresh() {}

    public void setEnabled(boolean enabled) {}

    public void confirmSelectionThenRun(Runnable action) {
        action.run();
    }
}
