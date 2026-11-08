package ly.nabda.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.telephony.SmsManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public final class GatewayService extends Service {
    public static volatile boolean running=false;
    public static volatile boolean live=false;
    private static final Object SUBMISSION_LOCK=new Object();
    private static long generation=0;
    private long serviceGeneration;
    private boolean sendingLive;
    private volatile boolean stopping=false;
    private Thread loop;
    private Settings settings;
    private LocalStore store;
    private static final String CHANNEL="nabda-running";
    @Override public void onCreate(){super.onCreate();settings=new Settings(this);store=new LocalStore(this);((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel(CHANNEL,"Nabda connection",NotificationManager.IMPORTANCE_LOW));}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&"STOP".equals(intent.getAction())){stop(this);return START_NOT_STICKY;}
        if(running)return START_NOT_STICKY;
        sendingLive=intent!=null&&"START_LIVE".equals(intent.getAction());live=sendingLive;
        if(settings.credentials()==null){settings.state("Pair your phone first.");stopSelf();return START_NOT_STICKY;}
        if(live)try{requireSim();}catch(Exception error){settings.state(error.getMessage());stopSelf();return START_NOT_STICKY;}
        Notification notification=notification(live?"Phone sending is on":"Test connection is on");
        if(Build.VERSION.SDK_INT>=34)startForeground(42,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);else startForeground(42,notification);
        synchronized(SUBMISSION_LOCK){serviceGeneration=++generation;running=true;stopping=false;}
        loop=new Thread(this::work,"nabda-gateway");loop.start();return START_NOT_STICKY;
    }
    private Notification notification(String text){
        PendingIntent open=PendingIntent.getActivity(this,1,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop=PendingIntent.getService(this,2,new Intent(this,GatewayService.class).setAction("STOP"),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this,CHANNEL).setSmallIcon(ly.nabda.mobile.R.drawable.ic_nabda).setContentTitle("نبضة").setContentText(text).setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null,"Stop",stop).build()).build();
    }
    private void state(String text){if(serviceGeneration>0&&!active())return;settings.state(text);((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(42,notification(text));}
    private void work(){
        JSONObject credentials=settings.credentials();if(credentials==null)return;
        String device=Settings.scope(credentials),server=credentials.optString("server"),token=credentials.optString("token");
        try{store.recoverUncertain(device);}catch(Exception error){state("Could not open the local queue. Restart Nabda.");stopSelf();return;}
        long nextNetwork=0;int backoff=60000;
        while(active()){
            try{
                if(System.currentTimeMillis()>=nextNetwork){
                    try{
                        acknowledge(server,token,device);
                        uploadEvents(server,token,device);
                        boolean permission=checkSelfPermission(Manifest.permission.SEND_SMS)==PackageManager.PERMISSION_GRANTED;
                        boolean sim=false;try{requireSim();sim=true;}catch(Exception ignored){}
                        JSONObject payload=new JSONObject().put("ready",!sendingLive||(permission&&sim)).put("permission_granted",permission).put("sim_selected",sim).put("app_version","0.2.0").put("android_version",Build.VERSION.RELEASE);
                        JSONObject response=Api.post(server,"/v1/device/poll",token,payload);
                        store.receive(device,response.optJSONArray("commands")==null?new JSONArray():response.getJSONArray("commands"));
                        acknowledge(server,token,device);uploadEvents(server,token,device);
                        backoff=60000;nextNetwork=System.currentTimeMillis()+Math.max(60000,Math.min(300000,response.optLong("poll_after_ms",60000)));
                        if(active())state(sendingLive?"Connected. Phone sending is on.":"Connected in test mode. Live jobs wait.");
                    }catch(Api.Failure error){
                        state(error.status==401?"Pairing is no longer valid. Stop and pair again.":"Server: "+error.getMessage());
                        if(error.status==401){stopSelf();break;}
                        nextNetwork=System.currentTimeMillis()+backoff;backoff=Math.min(300000,backoff*2);
                    }catch(Exception error){state("Offline. Your saved queue stays on this phone.");nextNetwork=System.currentTimeMillis()+backoff;backoff=Math.min(300000,backoff*2);}
                }
                if(!active())break;
                store.markTimedOut(device);
                if(store.count(device,"'processing'")==0){
                    JSONObject message=store.next(device,sendingLive);
                    if(message!=null&&System.currentTimeMillis()-settings.lastSend()>=settings.intervalSeconds()*1000L){dispatch(device,message);}
                }
                Thread.sleep(1000);
            }catch(InterruptedException error){Thread.currentThread().interrupt();break;}
            catch(Exception error){state("Queue needs attention. Open Nabda to review.");try{Thread.sleep(5000);}catch(InterruptedException interrupted){break;}}
        }
    }
    private void acknowledge(String server,String token,String device)throws Exception{
        JSONArray ids=store.unacknowledged(device);if(ids.length()==0)return;
        JSONObject result=Api.post(server,"/v1/device/ack",token,new JSONObject().put("command_ids",ids));
        store.acknowledge(device,result.optJSONArray("acknowledged")==null?new JSONArray():result.getJSONArray("acknowledged"));
        if(result.optJSONArray("rejected")!=null)store.reject(device,result.getJSONArray("rejected"));
    }
    private void uploadEvents(String server,String token,String device)throws Exception{
        JSONArray events=store.events(device);if(events.length()==0)return;
        JSONObject result=Api.post(server,"/v1/device/events",token,new JSONObject().put("events",events));
        store.eventsAcknowledged(device,result.optJSONArray("accepted")==null?new JSONArray():result.getJSONArray("accepted"));
    }
    private int requireSim(){
        if(!getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY_MESSAGING))throw new IllegalStateException("This device does not support carrier SMS messaging.");
        if(checkSelfPermission(Manifest.permission.SEND_SMS)!=PackageManager.PERMISSION_GRANTED||checkSelfPermission(Manifest.permission.READ_PHONE_STATE)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("SMS and phone permissions are needed before phone sending.");
        int chosen=settings.sim();SubscriptionManager manager=getSystemService(SubscriptionManager.class);List<SubscriptionInfo> active=manager==null?null:manager.getActiveSubscriptionInfoList();
        if(active!=null)for(SubscriptionInfo info:active)if(info.getSubscriptionId()==chosen)return chosen;
        throw new IllegalStateException("Choose an active sending SIM in Nabda.");
    }
    private void dispatch(String device,JSONObject message)throws Exception{
        if(!active())return;
        String id=message.getString("id");
        if(message.optInt("sandbox",0)==1){
            synchronized(SUBMISSION_LOCK){if(!active())return;String attempt=store.begin(device,id,1,-1);store.partResult(id,attempt,0,false,true,null);store.partResult(id,attempt,0,true,true,null);settings.lastSend(System.currentTimeMillis());}return;
        }
        if(!sendingLive)return;
        int subscription;try{subscription=requireSim();}catch(Exception error){state(error.getMessage());return;}
        SmsManager manager=Build.VERSION.SDK_INT>=31?getSystemService(SmsManager.class).createForSubscriptionId(subscription):SmsManager.getSmsManagerForSubscriptionId(subscription);
        ArrayList<String> parts=manager.divideMessage(message.getString("content"));
        if(parts.isEmpty()||parts.size()>100){store.terminal(device,id,"failed","UNSUPPORTED_PART_COUNT");return;}
        synchronized(SUBMISSION_LOCK){
        if(!active())return;
        String attempt=store.begin(device,id,parts.size(),subscription);
        // Persist before crossing the modem boundary. A later interruption becomes unknown, never an automatic retry.
        settings.lastSend(System.currentTimeMillis()+settings.intervalSeconds()*1000L*(parts.size()-1));
        ArrayList<PendingIntent> sent=new ArrayList<>(),delivered=new ArrayList<>();
        for(int i=0;i<parts.size();i++){sent.add(callback(id,attempt,i,false));delivered.add(callback(id,attempt,i,true));}
        try{
            if(parts.size()==1)manager.sendTextMessage(message.getString("recipient"),null,parts.get(0),sent.get(0),delivered.get(0));
            else manager.sendMultipartTextMessage(message.getString("recipient"),null,parts,sent,delivered);
        }catch(SecurityException error){store.terminal(device,id,"failed","SMS_PERMISSION_REVOKED");state("SMS permission changed. Stop and check permissions.");}
        catch(IllegalArgumentException error){store.terminal(device,id,"failed","INVALID_SMS_ARGUMENTS");}
        catch(RuntimeException error){store.terminal(device,id,"outcome_unknown","MODEM_CALL_INTERRUPTED");}
        }
    }
    private PendingIntent callback(String id,String attempt,int index,boolean delivery){
        Intent intent=new Intent(this,SmsResultReceiver.class).setAction(delivery?"ly.nabda.DELIVERED":"ly.nabda.SENT").setData(Uri.parse("nabda-result://"+attempt+"/"+index+"/"+(delivery?"delivery":"sent"))).putExtra("message_id",id).putExtra("attempt_id",attempt).putExtra("part_index",index).putExtra("delivery",delivery);
        return PendingIntent.getBroadcast(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    }
    private boolean active(){synchronized(SUBMISSION_LOCK){return !stopping&&serviceGeneration==generation;}}
    static void stop(android.content.Context context){synchronized(SUBMISSION_LOCK){generation++;running=false;live=false;}context.stopService(new Intent(context,GatewayService.class));}
    @Override public void onDestroy(){synchronized(SUBMISSION_LOCK){stopping=true;if(serviceGeneration==generation){generation++;running=false;live=false;}}if(loop!=null)loop.interrupt();settings.state("Stopped. Saved messages stay on this phone.");stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
