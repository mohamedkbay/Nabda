package com.nabda.agent;

public final class DispatchResult {
    public final String status;
    public final String providerMessageId;

    private DispatchResult(String status, String providerMessageId) {
        this.status = status;
        this.providerMessageId = providerMessageId;
    }

    public static DispatchResult sent(String providerMessageId) {
        return new DispatchResult("sent", providerMessageId);
    }
}
