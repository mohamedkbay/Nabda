package com.nabda.agent;

import android.content.Context;

public interface MessageDispatcher {
    DispatchResult dispatch(Context context, ClaimedMessage message) throws Exception;
}
