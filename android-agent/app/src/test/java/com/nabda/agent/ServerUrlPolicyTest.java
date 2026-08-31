package com.nabda.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class ServerUrlPolicyTest {
    @Test public void acceptsOnlyPrivateIpv4LanRanges() {
        assertEquals("http://10.1.2.3:47831", ServerUrlPolicy.normalize(" http://10.1.2.3:47831/ ", false));
        assertEquals("http://172.16.4.5:47831", ServerUrlPolicy.normalize("http://172.16.4.5:47831", false));
        assertEquals("http://172.31.255.254:47831", ServerUrlPolicy.normalize("http://172.31.255.254:47831", true));
        assertEquals("http://192.168.1.20:47831", ServerUrlPolicy.normalize("http://192.168.1.20:47831", false));
    }

    @Test public void rejectsPublicLoopbackLinkLocalAndHostnameTargets() {
        expectRejected("http://8.8.8.8:47831");
        expectRejected("http://127.0.0.1:47831");
        expectRejected("http://169.254.1.2:47831");
        expectRejected("http://localhost:47831");
        expectRejected("http://desktop.local:47831");
        expectRejected("http://172.15.1.2:47831");
        expectRejected("http://172.32.1.2:47831");
    }

    @Test public void rejectsHttpsMissingPortCredentialsPathsQueryAndFragments() {
        expectRejected("https://192.168.1.20:47831");
        expectRejected("http://192.168.1.20");
        expectRejected("http://user:secret@192.168.1.20:47831");
        expectRejected("http://192.168.1.20:47831/api");
        expectRejected("http://192.168.1.20:47831?secret=x");
        expectRejected("http://192.168.1.20:47831/#fragment");
    }

    private static void expectRejected(String value) {
        try {
            ServerUrlPolicy.normalize(value, false);
            fail("Expected URL to be rejected: " + value);
        } catch (IllegalArgumentException expected) {
            // Expected.
        }
    }
}
