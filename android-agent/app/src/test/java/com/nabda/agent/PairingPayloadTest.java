package com.nabda.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public final class PairingPayloadTest {
    private static final String CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcDE";

    @Test public void parsesStrictVersionedDesktopQr() throws Exception {
        String endpoint = "http://192.168.1.20:47831";
        String qr = "nabda://pair?v=1&endpoint="
                + URLEncoder.encode(endpoint, StandardCharsets.UTF_8.name())
                + "&code=" + CODE + "&desktop=DESK_7";
        PairingPayload payload = PairingPayload.fromQrUri(qr);
        assertEquals(endpoint, payload.serverUrl);
        assertEquals(CODE, payload.pairingCode);
        assertEquals("DESK_7", payload.desktopId);
    }

    @Test public void preservesCaseSensitiveBase64UrlSecret() {
        assertEquals(CODE, PairingPayload.fromManual("http://10.0.0.5:47831", CODE).pairingCode);
    }

    @Test public void rejectsWrongVersionExtraFieldsShortSecretAndPublicEndpoint() throws Exception {
        String endpoint = URLEncoder.encode("http://192.168.1.20:47831", StandardCharsets.UTF_8.name());
        expectRejected("nabda://pair?v=2&endpoint=" + endpoint + "&code=" + CODE + "&desktop=PC1");
        expectRejected("nabda://pair?v=1&endpoint=" + endpoint + "&code=" + CODE + "&desktop=PC1&extra=x");
        expectRejected("nabda://pair?v=1&endpoint=" + endpoint + "&code=short&desktop=PC1");
        expectRejected("nabda://pair?v=1&endpoint=http%3A%2F%2F8.8.8.8%3A47831&code=" + CODE + "&desktop=PC1");
    }

    private static void expectRejected(String value) {
        try {
            PairingPayload.fromQrUri(value);
            fail("Expected QR to be rejected");
        } catch (IllegalArgumentException expected) {
            // Expected.
        }
    }
}
