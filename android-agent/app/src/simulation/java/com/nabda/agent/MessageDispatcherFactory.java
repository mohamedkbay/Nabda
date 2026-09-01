package com.nabda.agent;

import java.util.UUID;

/** The default build has no SmsManager reference and cannot send a carrier SMS. */
public final class MessageDispatcherFactory {
    private MessageDispatcherFactory() {}

    public static MessageDispatcher create() {
        return (context, message) -> DispatchResult.sent("simulation_" + UUID.randomUUID());
    }
}
