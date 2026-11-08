package ly.nabda.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.time.Instant;
import java.util.UUID;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=34, manifest=Config.NONE)
public class LocalStoreTest {
    private LocalStore store;
    private static final String DEVICE="device-alice";
    @Before public void setup(){Context context=RuntimeEnvironment.getApplication();context.deleteDatabase("nabda-phone.sqlite3");store=new LocalStore(context);}
    @After public void close(){store.close();}
    private JSONObject command(String message)throws Exception{return new JSONObject().put("id",UUID.randomUUID().toString()).put("type","message.send").put("message_id",message).put("payload",new JSONObject().put("to","+218912345678").put("content","hello\nworld").put("sandbox",true).put("expires_at",Instant.now().plusSeconds(3600).toString()));}
    private JSONObject queue()throws Exception{JSONObject cmd=command(UUID.randomUUID().toString());store.receive(DEVICE,new JSONArray().put(cmd));store.acknowledge(DEVICE,new JSONArray().put(cmd.getString("id")));return cmd;}
    @Test public void stagedQueueNeedsExplicitCloudAckAndDeduplicates()throws Exception{
        JSONObject c=command(UUID.randomUUID().toString());JSONArray commands=new JSONArray().put(c);store.receive(DEVICE,commands);store.receive(DEVICE,commands);
        assertEquals(1,store.count(DEVICE,"'staged'"));assertNull(store.next(DEVICE,false));assertEquals(0,store.events(DEVICE).length());
        store.acknowledge(DEVICE,new JSONArray().put(c.getString("id")));assertEquals("hello\nworld",store.next(DEVICE,false).getString("content"));
        store.acknowledge(DEVICE,new JSONArray().put(c.getString("id")));assertEquals(1,store.events(DEVICE).length());
    }
    @Test public void rejectedHandoffCannotSendAndDoesNotPoisonEventUpload()throws Exception{
        JSONObject c=command(UUID.randomUUID().toString());store.receive(DEVICE,new JSONArray().put(c));
        store.reject(DEVICE,new JSONArray().put(new JSONObject().put("id",c.getString("id")).put("reason","cancelled")));
        assertNull(store.next(DEVICE,true));assertEquals(0,store.events(DEVICE).length());assertEquals(1,store.count(DEVICE,"'cancelled'"));
    }
    @Test public void locallyCancelledStagedJobReportsOnlyAfterHandoff()throws Exception{
        JSONObject c=command(UUID.randomUUID().toString());store.receive(DEVICE,new JSONArray().put(c));store.terminal(DEVICE,c.getString("message_id"),"cancelled","CANCELLED_LOCALLY");assertEquals(0,store.events(DEVICE).length());
        store.acknowledge(DEVICE,new JSONArray().put(c.getString("id")));assertEquals("cancelled",store.events(DEVICE).getJSONObject(0).getString("status"));assertNull(store.next(DEVICE,true));
    }
    @Test public void interruptedAttemptBecomesUnknownAndIsNeverRequeued()throws Exception{
        JSONObject c=queue();String id=c.getString("message_id");store.begin(DEVICE,id,2,1);store.recoverUncertain(DEVICE);
        assertEquals(1,store.count(DEVICE,"'outcome_unknown'"));assertNull(store.next(DEVICE,true));
        store.receive(DEVICE,new JSONArray().put(c));store.acknowledge(DEVICE,new JSONArray().put(c.getString("id")));assertNull(store.next(DEVICE,true));
    }
    @Test public void latePartCallbacksCanResolveUnknownWithoutAnotherSubmission()throws Exception{
        JSONObject c=queue();String id=c.getString("message_id"),attempt=store.begin(DEVICE,id,2,1);store.recoverUncertain(DEVICE);
        store.partResult(id,attempt,0,false,true,null);store.partResult(id,attempt,1,false,true,null);assertEquals(1,store.count(DEVICE,"'sent'"));
        store.partResult(id,attempt,0,true,true,null);store.partResult(id,attempt,1,true,true,null);assertEquals(1,store.count(DEVICE,"'delivered'"));assertNull(store.next(DEVICE,true));
    }
    @Test public void partialFailurePreservesFirstReasonAndWrongAttemptCannotOverwrite()throws Exception{
        JSONObject c=queue();String id=c.getString("message_id"),attempt=store.begin(DEVICE,id,3,1);
        store.partResult(id,attempt,0,false,false,"NO_SERVICE");store.partResult(id,attempt,1,false,true,null);store.partResult(id,attempt,2,false,true,null);
        assertEquals("SEND_FAILED:NO_SERVICE",store.history(DEVICE).getJSONObject(0).getString("failure_code"));
        store.partResult(id,"another-attempt",0,false,true,null);assertEquals(1,store.count(DEVICE,"'failed'"));
    }
    @Test public void eventAcknowledgmentAndDeviceScopeAreIndependent()throws Exception{
        queue();assertEquals(0,store.history("device-bob").length());assertNull(store.next("device-bob",true));
        JSONArray e=store.events(DEVICE);String id=e.getJSONObject(0).getString("event_id");store.eventsAcknowledged("device-bob",new JSONArray().put(id));assertEquals(1,store.events(DEVICE).length());
        store.eventsAcknowledged(DEVICE,new JSONArray().put(id));assertEquals(0,store.events(DEVICE).length());
    }
    @Test public void sandboxDoesNotReleaseLiveJobsInTestMode()throws Exception{
        JSONObject c=command(UUID.randomUUID().toString());c.getJSONObject("payload").put("sandbox",false);store.receive(DEVICE,new JSONArray().put(c));store.acknowledge(DEVICE,new JSONArray().put(c.getString("id")));
        assertNull(store.next(DEVICE,false));assertNotNull(store.next(DEVICE,true));
    }
    @Test public void dueMessagesAreNotStarvedByFutureQueueAndBlocklistIsEnforced()throws Exception{
        for(int i=0;i<105;i++){JSONObject c=command(UUID.randomUUID().toString());c.getJSONObject("payload").put("send_at",Instant.now().plusSeconds(1000).toString());store.receive(DEVICE,new JSONArray().put(c));store.acknowledge(DEVICE,new JSONArray().put(c.getString("id")));}
        JSONObject due=queue();assertEquals(due.getString("message_id"),store.next(DEVICE,true).getString("id"));
        store.block(DEVICE,"+218912345678");assertNull(store.next(DEVICE,true));assertEquals(1,store.count(DEVICE,"'cancelled'"));
    }
    @Test public void cancellationCannotPretendAnAlreadyStartedMessageWasRecalled()throws Exception{
        JSONObject c=queue();String id=c.getString("message_id");store.begin(DEVICE,id,1,1);
        JSONObject cancel=new JSONObject().put("id",UUID.randomUUID().toString()).put("type","message.cancel").put("message_id",id);
        store.receive(DEVICE,new JSONArray().put(cancel));assertEquals(1,store.count(DEVICE,"'processing'"));assertEquals(0,store.count(DEVICE,"'cancelled'"));
    }
}
