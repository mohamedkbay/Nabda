package com.nabda.agent;

import java.util.LinkedHashMap;
import java.util.Map;

/** Exact, small protocol shared by pairing and connectivity-only heartbeats. */
public final class LocalProtocol {
    public static final String PAIRING_CLAIM_PATH = "/local/v1/pairing/claim";
    public static final String HEARTBEAT_PATH = "/local/v1/device/heartbeat";

    private LocalProtocol() {}

    public static Map<String, Object> pairingClaim(
            String code,
            String phoneName,
            String installationId,
            String appVersion) {
        Map<String, Object> phone = new LinkedHashMap<>();
        phone.put("name", phoneName);
        phone.put("installationId", installationId);
        phone.put("platform", "android");
        phone.put("appVersion", appVersion);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("phone", phone);
        return body;
    }

    public static Map<String, Object> heartbeat(String installationId, String appVersion) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("installationId", installationId);
        body.put("appVersion", appVersion);
        return body;
    }
}
