package ly.nabda.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.view.View;
import android.widget.*;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Deliberately small native interface: pair, choose SIM, start/stop, review. */
public final class MainActivity extends Activity {
    private Settings settings;private LocalStore store;private LinearLayout content;private TextView status,counts;private EditText server,token;
    private Spinner sims;private List<SubscriptionInfo> simChoices=new ArrayList<>();private boolean busy=false;private final Handler handler=new Handler();
    private static final int INK=Color.rgb(27,47,40),PAPER=Color.rgb(250,248,241),GREEN=Color.rgb(39,99,75);
    private boolean ar(){return settings.arabic();}private String t(String en,String arabic){return ar()?arabic:en;}
    private int dp(int value){return Math.round(getResources().getDisplayMetrics().density*value);}
    @Override public void onCreate(Bundle state){super.onCreate(state);settings=new Settings(this);store=new LocalStore(this);render();readLink(getIntent());}
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);readLink(intent);}
    @Override protected void onResume(){super.onResume();handler.post(refresh);}
    @Override protected void onPause(){handler.removeCallbacks(refresh);super.onPause();}
    @Override protected void onDestroy(){handler.removeCallbacksAndMessages(null);store.close();super.onDestroy();}
    private final Runnable refresh=new Runnable(){@Override public void run(){refreshStatus();handler.postDelayed(this,2000);}};
    private TextView text(String value,int size,boolean bold){TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(INK);if(bold)v.setTypeface(Typeface.DEFAULT,Typeface.BOLD);v.setPadding(0,dp(5),0,dp(5));return v;}
    private void add(TextView v){content.addView(v,new LinearLayout.LayoutParams(-1,-2));}
    private Button button(String label,Runnable click,boolean primary){Button b=new Button(this);b.setText(label);b.setAllCaps(false);b.setTextColor(primary?Color.WHITE:INK);b.setTextSize(15);b.setMinHeight(dp(50));GradientDrawable bg=new GradientDrawable();bg.setColor(primary?GREEN:Color.WHITE);bg.setCornerRadius(dp(12));if(!primary)bg.setStroke(dp(1),0xFFB9C3B8);b.setBackground(bg);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(52));p.setMargins(0,dp(7),0,dp(3));content.addView(b,p);b.setOnClickListener(v->click.run());return b;}
    private EditText input(String hint){EditText e=new EditText(this);e.setTextColor(INK);e.setHintTextColor(0xFF657169);e.setHint(hint);e.setSingleLine(true);e.setTextSize(14);e.setPadding(dp(12),dp(10),dp(12),dp(10));GradientDrawable bg=new GradientDrawable();bg.setColor(Color.WHITE);bg.setStroke(dp(1),0xFFB9C3B8);bg.setCornerRadius(dp(10));e.setBackground(bg);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(48));p.setMargins(0,dp(6),0,dp(4));content.addView(e,p);return e;}
    private void gap(){View line=new View(this);line.setBackgroundColor(0xFFD9DFD2);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(1));p.setMargins(0,dp(23),0,dp(18));content.addView(line,p);}
    private void render(){
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(PAPER);content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(dp(24),dp(24),dp(24),dp(32));content.setLayoutDirection(ar()?View.LAYOUT_DIRECTION_RTL:View.LAYOUT_DIRECTION_LTR);scroll.addView(content);setContentView(scroll);
        LinearLayout header=new LinearLayout(this);header.setGravity(android.view.Gravity.CENTER_VERTICAL);android.widget.ImageView logo=new android.widget.ImageView(this);logo.setImageResource(R.drawable.ic_nabda);logo.setContentDescription("Nabda");header.addView(logo,new LinearLayout.LayoutParams(dp(60),dp(60)));TextView brand=text("نبضة",34,true);header.addView(brand,new LinearLayout.LayoutParams(0,-2,1));Button lang=new Button(this);lang.setText(ar()?"English":"العربية");lang.setAllCaps(false);lang.setOnClickListener(v->{settings.arabic(!ar());render();});header.addView(lang);content.addView(header);
        add(text(t("Your phone is the gateway.","هاتفك هو بوابة الإرسال."),22,true));add(text(t("Messages and their history stay here. Nabda connects your applications to this phone.","الرسائل وسجلّها هنا في هاتفك. نبضة تربط برامجك به."),15,false));
        status=text(settings.state(),15,true);add(status);counts=text("",15,false);add(counts);
        JSONObject credentials=settings.credentials();add(text(credentials==null?t("Not paired yet","لم يُربط الهاتف بعد"):credentials.optString("server"),13,false));
        button(t("Scan the pairing QR","مسح رمز الربط"),this::scan,false);
        server=input(t("Site address — https://…","عنوان الموقع — https://…"));server.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_URI);server.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);if(credentials!=null)server.setText(credentials.optString("server"));
        token=input(t("Pairing code from your dashboard","رمز الربط من لوحة التحكم"));token.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);token.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        button(t("Pair this phone","ربط الهاتف"),this::pair,true);gap();
        add(text(t("Choose the sending SIM","اختر شريحة الإرسال"),19,true));sims=new Spinner(this);content.addView(sims,new LinearLayout.LayoutParams(-1,dp(50)));refreshSims();
        button(t("Allow SMS & find SIM cards","منح الصلاحيات وإظهار الشرائح"),()->permissions(false),false);
        button(t("Connect in test mode","الاتصال بوضع التجربة"),()->start(false),false);
        button(t("Start phone sending","بدء الإرسال من الهاتف"),()->permissions(true),true);
        button(t("Stop the connection and sending","إيقاف الاتصال والإرسال"),()->{GatewayService.stop(this);refreshStatus();refreshSims();},false);
        add(text(t("Test mode only sends simulated results. Live jobs wait until you start phone sending. Stop prevents new submissions; it cannot recall an SMS already submitted.","وضع التجربة يعطي نتائج محاكاة فقط. الرسائل الحقيقية تنتظر حتى تبدأ الإرسال. الإيقاف يمنع المحاولات الجديدة ولا يسحب رسالة بدأت بالفعل."),13,false));
        gap();add(text(t("On this phone","داخل هذا الهاتف"),20,true));
        button(t("Queue & message history","الطابور وسجل الرسائل"),this::history,false);
        button(t("Blocked numbers","الأرقام الموقوفة"),this::blocklist,false);
        button(t("Sending pace","توقيت الإرسال"),this::pace,false);
        button(t("Help & optional support","المساعدة والدعم الاختياري"),()->{JSONObject c=settings.credentials();if(c==null){toast(t("Pair your site first.","اربط موقعك أولًا."));return;}startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(c.optString("server")+"/support")));},false);
        add(text(t("The connection checks for new work about once a minute. Once a job is handed over, this phone can finish it without internet. Your carrier still handles SMS delivery and charges.","نفحص الطلبات الجديدة كل دقيقة تقريبًا. بعد استلامها يستطيع الهاتف إكمالها دون إنترنت. إرسال SMS وتكلفتها يظلان عبر شركة الاتصالات."),13,false));
        add(text("Nabda Android 0.2.0 · free to use",12,false));refreshStatus();
    }
    private void refreshStatus(){if(status==null)return;status.setText((GatewayService.running?(GatewayService.live?t("Phone sending is on","الإرسال من الهاتف يعمل"):t("Test connection is on","الاتصال التجريبي يعمل")):t("Stopped","متوقف"))+"\n"+settings.state());String device=device();counts.setText(t("Waiting: ","بانتظار الإرسال: ")+store.count(device,"'staged','queued'")+t("   Sent: ","   أُرسلت: ")+store.count(device,"'sent','delivered'")+t("   Review: ","   للمراجعة: ")+store.count(device,"'failed','outcome_unknown'"));}
    private void readLink(Intent intent){Uri uri=intent.getData();if(uri!=null&&"nabda".equals(uri.getScheme())&&"pair".equals(uri.getHost())){String s=uri.getQueryParameter("server"),p=uri.getQueryParameter("token");if(s!=null&&p!=null){server.setText(s);token.setText(p);toast(t("Pairing details filled. Tap Pair this phone.","تم تعبئة بيانات الربط. اضغط ربط الهاتف."));}}}
    private void scan(){if(GatewayService.running){toast(t("Stop the connection before pairing another site.","أوقف الاتصال قبل ربط موقع آخر."));return;}if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.CAMERA},70);return;}new IntentIntegrator(this).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt(t("Scan the QR on your Nabda dashboard","امسح رمز الربط من لوحة نبضة")).setBeepEnabled(false).setOrientationLocked(false).initiateScan();}
    @Override public void onActivityResult(int requestCode,int resultCode,Intent data){IntentResult result=IntentIntegrator.parseActivityResult(requestCode,resultCode,data);if(result!=null){if(result.getContents()==null)return;try{String raw=result.getContents();if(raw.startsWith("nabda://")){readLink(new Intent(Intent.ACTION_VIEW,Uri.parse(raw)));}else{JSONObject qr=new JSONObject(raw);server.setText(qr.getString("server_url"));token.setText(qr.getString("pairing_token"));toast(t("Ready. Tap Pair this phone.","جاهز. اضغط ربط الهاتف."));}}catch(Exception e){toast(t("This QR is not a Nabda pairing code.","هذا الرمز ليس رمز ربط نبضة."));}return;}super.onActivityResult(requestCode,resultCode,data);}
    private void pair(){
        if(busy)return;if(GatewayService.running){toast(t("Stop the connection before pairing.","أوقف الاتصال قبل الربط."));return;}
        final String s=server.getText().toString(),p=token.getText().toString().trim();if(p.length()<16){toast(t("Copy the full pairing code from the website.","انسخ رمز الربط كاملًا من الموقع."));return;}
        busy=true;status.setText(t("Pairing…","جارٍ الربط…"));
        new Thread(()->{try{String origin=Api.normalize(s);JSONObject response=Api.post(origin,"/v1/device/pair",null,new JSONObject().put("pairing_token",p).put("name",Build.MANUFACTURER+" "+Build.MODEL).put("android_version",Build.VERSION.RELEASE).put("app_version","0.2.0"));
            String returned=Api.normalize(response.getString("server_url"));if(!origin.equals(returned))throw new IllegalStateException("Pairing server changed its origin.");
            settings.saveCredentials(origin,response.getString("device_id"),response.getString("device_token"));settings.state(t("Paired. Choose your SIM, then connect.","تم الربط. اختر الشريحة ثم ابدأ الاتصال."));runOnUiThread(()->{token.setText("");render();});
        }catch(Exception error){runOnUiThread(()->{status.setText(error.getMessage());toast(error.getMessage());});}finally{busy=false;}}).start();
    }
    private void permissions(boolean startLive){ArrayList<String> needed=new ArrayList<>();for(String permission:new String[]{Manifest.permission.SEND_SMS,Manifest.permission.READ_PHONE_STATE})if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED)needed.add(permission);if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)needed.add(Manifest.permission.POST_NOTIFICATIONS);if(!needed.isEmpty()){requestPermissions(needed.toArray(new String[0]),startLive?72:71);return;}refreshSims();if(startLive)start(true);}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==70){if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)scan();else toast(t("Camera access is optional. You can paste the pairing code instead.","الكاميرا اختيارية. يمكنك لصق رمز الربط بدلًا منها."));}else if(request==71||request==72){refreshSims();if(request==72&&checkSelfPermission(Manifest.permission.SEND_SMS)==PackageManager.PERMISSION_GRANTED&&checkSelfPermission(Manifest.permission.READ_PHONE_STATE)==PackageManager.PERMISSION_GRANTED)start(true);else toast(t("Allow SMS and phone permission to send. Test mode still works.","امنح صلاحيات الرسائل والهاتف للإرسال. يظل وضع التجربة متاحًا."));}}
    private void refreshSims(){
        simChoices=new ArrayList<>();ArrayList<String> names=new ArrayList<>();names.add(t("Choose a SIM…","اختر شريحة…"));
        if(checkSelfPermission(Manifest.permission.READ_PHONE_STATE)==PackageManager.PERMISSION_GRANTED){SubscriptionManager m=getSystemService(SubscriptionManager.class);List<SubscriptionInfo> active=m==null?null:m.getActiveSubscriptionInfoList();if(active!=null){active=new ArrayList<>(active);active.sort((a,b)->Integer.compare(a.getSimSlotIndex(),b.getSimSlotIndex()));for(SubscriptionInfo info:active){simChoices.add(info);names.add("SIM "+(info.getSimSlotIndex()+1)+" · "+info.getCarrierName());}}}
        sims.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,names));int selected=0;for(int i=0;i<simChoices.size();i++)if(simChoices.get(i).getSubscriptionId()==settings.sim())selected=i+1;sims.setSelection(selected);
        sims.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){@Override public void onItemSelected(AdapterView<?> parent,View view,int position,long id){if(!GatewayService.running)settings.sim(position>0?simChoices.get(position-1).getSubscriptionId():-1);}@Override public void onNothingSelected(AdapterView<?> parent){}});sims.setEnabled(!GatewayService.running);
    }
    private void start(boolean real){if(settings.credentials()==null){toast(t("Pair your phone first.","اربط الهاتف أولًا."));return;}if(GatewayService.running){toast(t("Already connected. Stop before changing mode or SIM.","الاتصال يعمل. أوقفه قبل تغيير الوضع أو الشريحة."));return;}if(real){boolean active=false;for(SubscriptionInfo info:simChoices)if(info.getSubscriptionId()==settings.sim())active=true;if(!active){toast(t("Choose an active sending SIM first.","اختر شريحة إرسال نشطة أولًا."));return;}}try{startForegroundService(new Intent(this,GatewayService.class).setAction(real?"START_LIVE":"START_TEST"));}catch(Exception error){toast(error.getMessage());}handler.postDelayed(()->{refreshStatus();refreshSims();},500);}
    private String device(){return Settings.scope(settings.credentials());}
    private void history(){try{JSONArray rows=store.history(device());LinearLayout list=new LinearLayout(this);list.setOrientation(LinearLayout.VERTICAL);list.setPadding(dp(18),dp(8),dp(18),dp(18));if(rows.length()==0)list.addView(text(t("No messages here yet.","لا توجد رسائل هنا بعد."),16,false));for(int i=0;i<rows.length();i++){JSONObject m=rows.getJSONObject(i);String label=m.optString("recipient")+"  ·  "+m.optString("status")+(m.optInt("sandbox")==1?" · TEST":"");TextView item=text(label+"\n"+m.optString("content")+"\n"+m.optString("updated_at")+(m.has("failure_code")?"\n"+m.optString("failure_code"):""),14,false);item.setTextIsSelectable(true);item.setPadding(0,dp(12),0,dp(16));list.addView(item);if("queued".equals(m.optString("status"))||"staged".equals(m.optString("status"))){Button cancel=new Button(this);cancel.setText(t("Cancel on this phone","إلغاء في الهاتف"));String id=m.getString("id");cancel.setOnClickListener(v->{try{store.terminal(device(),id,"cancelled","CANCELLED_LOCALLY");toast(t("Cancelled before sending.","أُلغيت قبل الإرسال."));}catch(Exception error){toast(error.getMessage());}});list.addView(cancel);}}ScrollView scroll=new ScrollView(this);scroll.addView(list);new AlertDialog.Builder(this).setTitle(t("Last 100 messages · local history","آخر 100 رسالة · سجل الهاتف")).setView(scroll).setPositiveButton(t("Close","إغلاق"),null).show();}catch(Exception error){toast(error.getMessage());}}
    private void blocklist(){if(device().isEmpty()){toast(t("Pair your phone first.","اربط الهاتف أولًا."));return;}LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(20),0,dp(20),0);EditText phone=new EditText(this);phone.setHint("091… / +218…");phone.setInputType(android.text.InputType.TYPE_CLASS_PHONE);box.addView(phone);TextView saved=text(String.join("\n",store.blocks(device())),14,false);box.addView(saved);new AlertDialog.Builder(this).setTitle(t("Blocked on this phone","أرقام موقوفة في الهاتف")).setView(box).setPositiveButton(t("Block number","إيقاف الرقم"),(d,w)->{String p=normalizePhone(phone.getText().toString());if(p==null){toast(t("Enter a valid phone number.","أدخل رقم هاتف صحيحًا."));return;}store.block(device(),p);toast(t("Number blocked.","تم إيقاف الرقم."));}).setNeutralButton(t("Unblock number","رفع الإيقاف"),(d,w)->{String p=normalizePhone(phone.getText().toString());if(p!=null)store.unblock(device(),p);}).setNegativeButton(t("Close","إغلاق"),null).show();}
    static String normalizePhone(String raw){return PhoneNumber.normalize(raw);}
    private void pace(){EditText input=new EditText(this);input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);input.setText(Integer.toString(settings.intervalSeconds()));new AlertDialog.Builder(this).setTitle(t("Seconds per SMS part","ثوانٍ لكل جزء SMS")).setMessage(t("The phone waits between submissions and respects Android errors. This is pacing, not a delivery guarantee.","ينتظر الهاتف بين المحاولات ويحترم أخطاء Android. هذا تنظيم للإرسال وليس ضمانًا للتسليم.")).setView(input).setPositiveButton(t("Save","حفظ"),(d,w)->{try{int value=Integer.parseInt(input.getText().toString());if(value<6||value>3600)throw new NumberFormatException();settings.intervalSeconds(value);}catch(Exception e){toast(t("Choose 6–3600 seconds.","اختر من 6 إلى 3600 ثانية."));}}).setNegativeButton(t("Cancel","إلغاء"),null).show();}
    private void toast(String message){Toast.makeText(this,message,Toast.LENGTH_LONG).show();}
}
