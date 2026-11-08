package ly.nabda.mobile;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.SmsManager;

public final class SmsResultReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        String id=intent.getStringExtra("message_id"),attempt=intent.getStringExtra("attempt_id");int index=intent.getIntExtra("part_index",-1);
        if(id==null||attempt==null||index<0)return;
        int result=getResultCode();boolean delivery=intent.getBooleanExtra("delivery",false);
        try(LocalStore store=new LocalStore(context)){
            store.partResult(id,attempt,index,delivery,result==Activity.RESULT_OK,result==Activity.RESULT_OK?null:reason(result));
            if(result==SmsManager.RESULT_ERROR_LIMIT_EXCEEDED){Settings settings=new Settings(context);settings.lastSend(System.currentTimeMillis()+60000);settings.state("Android paused sending. Waiting before the next message.");}
        }catch(Exception error){new Settings(context).state("An SMS result needs review. Open the local history.");}
    }
    private String reason(int code){
        if(code==SmsManager.RESULT_ERROR_NO_SERVICE)return "NO_SERVICE";
        if(code==SmsManager.RESULT_ERROR_RADIO_OFF)return "RADIO_OFF";
        if(code==SmsManager.RESULT_ERROR_LIMIT_EXCEEDED)return "ANDROID_SEND_LIMIT";
        return "ANDROID_RESULT_"+code;
    }
}
