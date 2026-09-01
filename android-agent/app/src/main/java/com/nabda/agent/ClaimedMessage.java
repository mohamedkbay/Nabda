package com.nabda.agent;

import org.json.JSONException;
import org.json.JSONObject;

public final class ClaimedMessage {
    public final String id;
    public final String to;
    public final String body;
    public final String leaseToken;
    public final String leaseExpiresAt;

    private ClaimedMessage(String id, String to, String body, String leaseToken, String leaseExpiresAt) {
        this.id = id;
        this.to = to;
        this.body = body;
        this.leaseToken = leaseToken;
        this.leaseExpiresAt = leaseExpiresAt;
    }

    public static ClaimedMessage fromJson(JSONObject value) throws JSONException {
        String id = required(value, "id");
        String to = required(value, "to");
        String body = required(value, "body");
        String leaseToken = required(value, "lease_token");
        String leaseExpiresAt = required(value, "lease_expires_at");
        if (body.length() > 5000) {
            throw new JSONException("Message body is too large");
        }
        return new ClaimedMessage(id, to, body, leaseToken, leaseExpiresAt);
    }

    private static String required(JSONObject value, String key) throws JSONException {
        String result = value.optString(key, "").trim();
        if (result.isEmpty()) {
            throw new JSONException("Missing " + key);
        }
        return result;
    }
}
