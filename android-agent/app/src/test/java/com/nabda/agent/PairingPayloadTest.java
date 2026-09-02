package com.nabda.agent;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class PairingPayloadTest {
    private static final String TOKEN = "nbda_pair_1234567890123456789012345678901234567890123";

    @Test
    public void acceptsVersionedPrivateLanPayloadInDebug() {
        PairingPayload payload = PairingPayload.parse(
                "nabda://pair?v=1&server=http%3A%2F%2F192.168.1.20%3A3210&token=" + TOKEN,
                true);
        assertEquals("http://192.168.1.20:3210", payload.serverUrl);
        assertEquals(TOKEN, payload.pairingToken);
    }

    @Test
    public void rejectsWrongSchemeAndDuplicateSecurityFields() {
        assertThrows(IllegalArgumentException.class, () -> PairingPayload.parse(
                "https://example.com/?v=1&server=https%3A%2F%2Fexample.com&token=" + TOKEN,
                false));
        assertThrows(IllegalArgumentException.class, () -> PairingPayload.parse(
                "nabda://pair?v=1&v=1&server=https%3A%2F%2Fexample.com&token=" + TOKEN,
                false));
    }

    @Test
    public void releasePairingStillRequiresHttps() {
        assertThrows(IllegalArgumentException.class, () -> PairingPayload.parse(
                "nabda://pair?v=1&server=http%3A%2F%2F192.168.1.20%3A3210&token=" + TOKEN,
                false));
    }
}
