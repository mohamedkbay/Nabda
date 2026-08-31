package com.nabda.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class ServerUrlPolicyTest {
    @Test
    public void releaseAcceptsHttpsAndStripsTrailingSlash() {
        assertEquals("https://api.example.com", ServerUrlPolicy.normalize(" https://api.example.com/ ", false));
    }

    @Test
    public void releaseRejectsHttp() {
        expectRejected("http://192.168.1.20:3000", false);
    }

    @Test
    public void debugAllowsOnlyLoopbackAndEmulatorGatewayHttp() {
        assertEquals("http://10.0.2.2:3000", ServerUrlPolicy.normalize("http://10.0.2.2:3000/", true));
        assertEquals("http://127.0.0.1:3000", ServerUrlPolicy.normalize("http://127.0.0.1:3000/", true));
        assertEquals("http://127.42.9.8:3000", ServerUrlPolicy.normalize("http://127.42.9.8:3000", true));
        assertEquals("http://[::1]:3000", ServerUrlPolicy.normalize("http://[::1]:3000/", true));
    }

    @Test
    public void debugRejectsLanLocalNamesPublicHttpAndEmbeddedCredentials() {
        expectRejected("http://192.168.1.20:3000", true);
        expectRejected("http://10.0.0.1:3000", true);
        expectRejected("http://10.1.2.3:3000", true);
        expectRejected("http://172.16.0.1:3000", true);
        expectRejected("http://172.31.4.5:3000", true);
        expectRejected("http://phone.local:3000", true);
        expectRejected("http://localhost:3000", true);
        expectRejected("http://example.com", true);
        expectRejected("https://token@example.com", true);
    }

    @Test
    public void debugRejectsLookalikeAndMalformedLoopbackHosts() {
        expectRejected("http://127.example.com:3000", true);
        expectRejected("http://127.0.0.1.example.com:3000", true);
        expectRejected("http://127.0.0.999:3000", true);
        expectRejected("http://10.0.2.20:3000", true);
    }

    @Test
    public void rejectsQueryAndFragment() {
        expectRejected("https://api.example.com?secret=x", false);
        expectRejected("https://api.example.com/#section", false);
    }

    private static void expectRejected(String value, boolean debug) {
        try {
            ServerUrlPolicy.normalize(value, debug);
            fail("Expected URL to be rejected: " + value);
        } catch (IllegalArgumentException expected) {
            // Expected.
        }
    }
}
