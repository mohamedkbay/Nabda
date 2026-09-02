package com.nabda.agent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Spinner;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/** Makes the sending subscription explicit. Never falls back to Android's default SIM. */
public final class SimSelectionController {
    private final Activity activity;
    private final View section;
    private final Spinner spinner;
    private final SecureSettings settings;
    private final List<Choice> choices = new ArrayList<>();
    private boolean updating;
    private boolean placeholderShown;

    public SimSelectionController(Activity activity, View section, Spinner spinner, SecureSettings settings) {
        this.activity = activity;
        this.section = section;
        this.spinner = spinner;
        this.settings = settings;
    }

    public void initialize() {
        section.setVisibility(View.VISIBLE);
        spinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                int choiceIndex = position - (placeholderShown ? 1 : 0);
                if (updating || choiceIndex < 0 || choiceIndex >= choices.size()) return;
                try {
                    settings.saveSelectedSubscriptionId(choices.get(choiceIndex).subscriptionId);
                } catch (Exception error) {
                    Toast.makeText(activity, "Could not securely save the SIM choice.", Toast.LENGTH_LONG).show();
                }
            }

            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        refresh();
    }

    public void refresh() {
        if (activity.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            choices.clear();
            placeholderShown = false;
            showLabels(Collections.singletonList("SIM cards appear after phone permission is granted"), -1);
            return;
        }
        List<SubscriptionInfo> active = activeSubscriptions();
        choices.clear();
        for (SubscriptionInfo info : active) {
            CharSequence carrier = info.getCarrierName();
            String name = carrier == null || carrier.toString().trim().isEmpty()
                    ? "Mobile network"
                    : carrier.toString().trim();
            choices.add(new Choice(info.getSubscriptionId(), "SIM " + (info.getSimSlotIndex() + 1) + " — " + name));
        }
        List<String> labels = new ArrayList<>();
        for (Choice choice : choices) labels.add(choice.label);
        if (labels.isEmpty()) labels.add("No active SIM card found");
        int saved = settings.loadSelectedSubscriptionId();
        int selected = indexOf(saved);
        placeholderShown = choices.size() > 1 && selected < 0;
        if (placeholderShown) labels.add(0, "Choose a sending SIM…");
        showLabels(labels, selected >= 0 ? selected : (choices.size() == 1 ? 0 : -1));
        if (choices.size() == 1 && selected < 0) persist(choices.get(0).subscriptionId);
    }

    public void confirmSelectionThenRun(Runnable action) {
        refresh();
        if (choices.isEmpty()) {
            Toast.makeText(activity, "Insert and enable a SIM card before starting.", Toast.LENGTH_LONG).show();
            return;
        }
        int saved = settings.loadSelectedSubscriptionId();
        int selected = indexOf(saved);
        if (selected >= 0) {
            spinner.setSelection(selected + (placeholderShown ? 1 : 0));
            action.run();
            return;
        }
        if (choices.size() == 1) {
            persist(choices.get(0).subscriptionId);
            spinner.setSelection(0);
            action.run();
            return;
        }
        String[] labels = new String[choices.size()];
        for (int index = 0; index < choices.size(); index++) labels[index] = choices.get(index).label;
        new AlertDialog.Builder(activity)
                .setTitle("Choose the sending SIM")
                .setItems(labels, (dialog, which) -> {
                    persist(choices.get(which).subscriptionId);
                    refresh();
                    spinner.setSelection(indexOf(choices.get(which).subscriptionId));
                    action.run();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private List<SubscriptionInfo> activeSubscriptions() {
        if (activity.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return Collections.emptyList();
        }
        SubscriptionManager manager = activity.getSystemService(SubscriptionManager.class);
        if (manager == null) return Collections.emptyList();
        try {
            List<SubscriptionInfo> active = manager.getActiveSubscriptionInfoList();
            if (active == null) return Collections.emptyList();
            List<SubscriptionInfo> sorted = new ArrayList<>(active);
            sorted.sort(Comparator.comparingInt(SubscriptionInfo::getSimSlotIndex));
            return sorted;
        } catch (SecurityException ignored) {
            return Collections.emptyList();
        }
    }

    private int indexOf(int subscriptionId) {
        for (int index = 0; index < choices.size(); index++) {
            if (choices.get(index).subscriptionId == subscriptionId) return index;
        }
        return -1;
    }

    private void showLabels(List<String> labels, int selected) {
        updating = true;
        spinner.setAdapter(new ArrayAdapter<>(activity, android.R.layout.simple_spinner_dropdown_item, labels));
        if (selected >= 0) spinner.setSelection(selected + (placeholderShown ? 1 : 0));
        updating = false;
    }

    public void setEnabled(boolean enabled) {
        spinner.setEnabled(enabled);
        section.setAlpha(enabled ? 1f : 0.68f);
    }

    private void persist(int subscriptionId) {
        try {
            settings.saveSelectedSubscriptionId(subscriptionId);
        } catch (Exception error) {
            Toast.makeText(activity, "Could not securely save the SIM choice.", Toast.LENGTH_LONG).show();
        }
    }

    private static final class Choice {
        final int subscriptionId;
        final String label;

        Choice(int subscriptionId, String label) {
            this.subscriptionId = subscriptionId;
            this.label = label;
        }
    }
}
