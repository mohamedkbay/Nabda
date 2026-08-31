package com.nabda.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

import java.util.Map;

public final class LocalProtocolTest {
    @Test public void pairingClaimMatchesDesktopContract() {
        Map<String, Object> body = LocalProtocol.pairingClaim("secret", "Pixel", "install-1", "1.0");
        assertEquals(2, body.size());
        assertEquals("secret", body.get("code"));
        Map<?, ?> phone = (Map<?, ?>) body.get("phone");
        assertEquals("Pixel", phone.get("name"));
        assertEquals("install-1", phone.get("installationId"));
        assertEquals("android", phone.get("platform"));
        assertEquals("1.0", phone.get("appVersion"));
    }

    @Test public void heartbeatContainsConnectivityOnlyFieldsAndNoSendInstruction() {
        Map<String, Object> heartbeat = LocalProtocol.heartbeat("install-1", "1.0");
        assertEquals(2, heartbeat.size());
        assertEquals("install-1", heartbeat.get("installationId"));
        assertEquals("1.0", heartbeat.get("appVersion"));
        assertFalse(heartbeat.containsKey("to"));
        assertFalse(heartbeat.containsKey("body"));
        assertFalse(heartbeat.containsKey("message"));
        assertEquals("/local/v1/device/heartbeat", LocalProtocol.HEARTBEAT_PATH);
    }
}
