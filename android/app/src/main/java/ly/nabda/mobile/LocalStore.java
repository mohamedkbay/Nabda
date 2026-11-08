package ly.nabda.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.util.ArrayList;
import java.util.UUID;

/** The phone is the authoritative owner of queue bodies, attempt journal and outcomes. */
final class LocalStore extends SQLiteOpenHelper {
    LocalStore(Context c) { super(c, "nabda-phone.sqlite3", null, 1); setWriteAheadLoggingEnabled(true); }
    @Override public void onConfigure(SQLiteDatabase db) { super.onConfigure(db); db.execSQL("PRAGMA synchronous=FULL"); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE messages(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, recipient TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, send_at TEXT, expires_at TEXT, sandbox INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempt_id TEXT, parts_total INTEGER NOT NULL DEFAULT 0, failure_code TEXT)");
        db.execSQL("CREATE INDEX message_queue ON messages(device_id,status,send_at)");
        db.execSQL("CREATE TABLE commands(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, message_id TEXT NOT NULL, type TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE attempts(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, started_at TEXT NOT NULL, sim_subscription INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE parts(attempt_id TEXT NOT NULL, part_index INTEGER NOT NULL, sent_result INTEGER, delivered_result INTEGER, PRIMARY KEY(attempt_id,part_index))");
        db.execSQL("CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, payload TEXT NOT NULL)");
        db.execSQL("CREATE TABLE blocklist(device_id TEXT NOT NULL, phone TEXT NOT NULL, PRIMARY KEY(device_id,phone))");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { throw new IllegalStateException("Database upgrade requires an explicit migration."); }
    static String now() { return Instant.now().toString(); }
    private static String nullable(JSONObject o, String key) { String value = o.optString(key, ""); return value.isEmpty() || "null".equals(value) ? null : value; }
    private void event(SQLiteDatabase db, String device, String messageId, String status, int total, int sent, int delivered, String failure) throws Exception {
        String id = UUID.randomUUID().toString();
        JSONObject payload = new JSONObject().put("event_id", id).put("message_id", messageId).put("status", status).put("occurred_at", now());
        if (total > 0) payload.put("parts_total", total).put("parts_sent", sent).put("parts_delivered", delivered);
        if (failure != null) payload.put("failure_code", failure);
        ContentValues row = new ContentValues(); row.put("id", id); row.put("device_id", device); row.put("payload", payload.toString()); db.insertOrThrow("events", null, row);
    }
    synchronized void receive(String device, JSONArray commands) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            for (int i = 0; i < Math.min(25, commands.length()); i++) {
                JSONObject command = commands.getJSONObject(i); String id = command.getString("id"), messageId = command.getString("message_id"), type = command.getString("type");
                if (!id.matches("[A-Za-z0-9_-]{8,150}") || !messageId.matches("[A-Za-z0-9_-]{8,150}")) throw new IllegalArgumentException("Invalid command identifier.");
                try (Cursor exists = db.rawQuery("SELECT id FROM commands WHERE id=?", new String[]{id})) { if (exists.moveToFirst()) continue; }
                if ("message.send".equals(type)) {
                    JSONObject payload = command.getJSONObject("payload");
                    String phone = payload.getString("to"), content = payload.getString("content");
                    if (!phone.matches("\\+[1-9][0-9]{6,14}") || content.isEmpty() || content.length() > 4000) throw new IllegalArgumentException("Invalid phone or message content.");
                    ContentValues m = new ContentValues(); m.put("id", messageId); m.put("device_id", device); m.put("recipient", phone); m.put("content", content); m.put("status", "staged");
                    m.put("send_at", nullable(payload, "send_at")); m.put("expires_at", nullable(payload, "expires_at")); m.put("sandbox", payload.optBoolean("sandbox", false) ? 1 : 0); m.put("created_at", now()); m.put("updated_at", now());
                    db.insertWithOnConflict("messages", null, m, SQLiteDatabase.CONFLICT_IGNORE);
                } else if ("message.cancel".equals(type)) {
                    try (Cursor m = db.rawQuery("SELECT status FROM messages WHERE id=? AND device_id=?", new String[]{messageId, device})) {
                        if (m.moveToFirst() && ("queued".equals(m.getString(0)) || "staged".equals(m.getString(0)))) terminal(db, device, messageId, "cancelled", null);
                    }
                } else { throw new IllegalArgumentException("Unsupported command type."); }
                ContentValues row = new ContentValues(); row.put("id", id); row.put("device_id", device); row.put("message_id", messageId); row.put("type", type); db.insertOrThrow("commands", null, row);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    synchronized JSONArray unacknowledged(String device) throws Exception {
        JSONArray ids = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id FROM commands WHERE device_id=? AND acknowledged=0 ORDER BY rowid LIMIT 25", new String[]{device})) { while (c.moveToNext()) ids.put(c.getString(0)); }
        return ids;
    }
    synchronized void acknowledge(String device, JSONArray ids) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            for (int i=0;i<ids.length();i++) {
                String id = ids.getString(i);
                try (Cursor c=db.rawQuery("SELECT message_id,type,acknowledged FROM commands WHERE id=? AND device_id=?",new String[]{id,device})) {
                    if(!c.moveToFirst()||c.getInt(2)==1)continue; String messageId=c.getString(0);
                    if("message.send".equals(c.getString(1))) {
                        ContentValues m=new ContentValues();m.put("status","queued");m.put("updated_at",now());
                        if(db.update("messages",m,"id=? AND device_id=? AND status='staged'",new String[]{messageId,device})>0)event(db,device,messageId,"queued",0,0,0,null);
                        else try(Cursor local=db.rawQuery("SELECT status FROM messages WHERE id=? AND device_id=?",new String[]{messageId,device})) {
                            if(local.moveToFirst()&&("cancelled".equals(local.getString(0))||"expired".equals(local.getString(0))))event(db,device,messageId,local.getString(0),0,0,0,null);
                        }
                    }
                }
                ContentValues a=new ContentValues();a.put("acknowledged",1);db.update("commands",a,"id=? AND device_id=?",new String[]{id,device});
            }
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }
    synchronized void reject(String device, JSONArray rejected) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            for(int i=0;i<rejected.length();i++) {
                Object value=rejected.get(i);String id=value instanceof JSONObject?((JSONObject)value).optString("id",((JSONObject)value).optString("command_id")):String.valueOf(value);
                try(Cursor c=db.rawQuery("SELECT message_id FROM commands WHERE id=? AND device_id=?",new String[]{id,device})) {
                    if(c.moveToFirst())terminal(db,device,c.getString(0),"cancelled","HANDOFF_REJECTED");
                }
                ContentValues a=new ContentValues();a.put("acknowledged",1);db.update("commands",a,"id=? AND device_id=?",new String[]{id,device});
            }
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    synchronized void recoverUncertain(String device) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try(Cursor c=db.rawQuery("SELECT id FROM messages WHERE device_id=? AND status='processing'",new String[]{device})) {
            while(c.moveToNext())terminal(db,device,c.getString(0),"outcome_unknown","APP_RESTART_DURING_SUBMISSION");db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    synchronized void markTimedOut(String device) throws Exception {
        String cutoff=Instant.now().minusSeconds(180).toString();SQLiteDatabase db=getWritableDatabase();
        try(Cursor c=db.rawQuery("SELECT id FROM messages WHERE device_id=? AND status='processing' AND updated_at<?",new String[]{device,cutoff})) {
            while(c.moveToNext())terminal(db,device,c.getString(0),"outcome_unknown","CALLBACK_TIMEOUT");
        }
    }
    private JSONObject record(Cursor c) throws Exception {
        JSONObject m=new JSONObject();for(int i=0;i<c.getColumnCount();i++){if(c.isNull(i))continue; int type=c.getType(i);m.put(c.getColumnName(i),type==Cursor.FIELD_TYPE_INTEGER?c.getLong(i):c.getString(i));}return m;
    }
    synchronized JSONObject next(String device, boolean live) throws Exception {
        SQLiteDatabase db=getWritableDatabase();
        try(Cursor c=db.rawQuery("SELECT * FROM messages WHERE device_id=? AND status='queued' AND (sandbox=1 OR CAST(? AS INTEGER)=1) AND (send_at IS NULL OR julianday(send_at)<=julianday('now')) ORDER BY COALESCE(send_at,created_at),created_at LIMIT 100",new String[]{device,live?"1":"0"})) {
            while(c.moveToNext()) {
                JSONObject m=record(c);String expiry=nullable(m,"expires_at"),scheduled=nullable(m,"send_at");
                if(expiry!=null&&!Instant.parse(expiry).isAfter(Instant.now())){terminal(db,device,m.getString("id"),"expired",null);continue;}
                if(scheduled!=null&&Instant.parse(scheduled).isAfter(Instant.now()))continue;
                if(blocked(device,m.getString("recipient"))){terminal(db,device,m.getString("id"),"cancelled","RECIPIENT_BLOCKED_LOCALLY");continue;}
                return m;
            }
        }
        return null;
    }
    synchronized String begin(String device, String id, int total, int sim) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            String attempt=UUID.randomUUID().toString();ContentValues m=new ContentValues();m.put("status","processing");m.put("attempt_id",attempt);m.put("parts_total",total);m.put("updated_at",now());
            if(db.update("messages",m,"id=? AND device_id=? AND status='queued'",new String[]{id,device})!=1)throw new IllegalStateException("Message is no longer queued.");
            ContentValues a=new ContentValues();a.put("id",attempt);a.put("message_id",id);a.put("started_at",now());a.put("sim_subscription",sim);db.insertOrThrow("attempts",null,a);
            for(int i=0;i<total;i++){ContentValues p=new ContentValues();p.put("attempt_id",attempt);p.put("part_index",i);db.insertOrThrow("parts",null,p);}
            event(db,device,id,"processing",total,0,0,null);db.setTransactionSuccessful();return attempt;
        }finally{db.endTransaction();}
    }
    synchronized void partResult(String id,String attempt,int index,boolean delivered,boolean success,String reason) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try(Cursor c=db.rawQuery("SELECT device_id,parts_total,status,attempt_id FROM messages WHERE id=?",new String[]{id})) {
            if(!c.moveToFirst()||!attempt.equals(c.getString(3)))return;String device=c.getString(0);int total=c.getInt(1);String before=c.getString(2);
            if("cancelled".equals(before)||"expired".equals(before))return;
            String column=delivered?"delivered_result":"sent_result";ContentValues p=new ContentValues();p.put(column,success?1:-1);
            if(db.update("parts",p,"attempt_id=? AND part_index=? AND "+column+" IS NULL",new String[]{attempt,Integer.toString(index)})==0){db.setTransactionSuccessful();return;}
            int sent=0,received=0,failed=0,deliveryFailed=0;
            try(Cursor counts=db.rawQuery("SELECT COALESCE(SUM(sent_result=1),0),COALESCE(SUM(delivered_result=1),0),COALESCE(SUM(sent_result=-1),0),COALESCE(SUM(delivered_result=-1),0) FROM parts WHERE attempt_id=?",new String[]{attempt})) {if(counts.moveToFirst()){sent=counts.getInt(0);received=counts.getInt(1);failed=counts.getInt(2);deliveryFailed=counts.getInt(3);}}
            String status=before;String failure=null;
            if(failed>0){status="failed";
                try(Cursor old=db.rawQuery("SELECT failure_code FROM messages WHERE id=?",new String[]{id})){if(old.moveToFirst())failure=old.getString(0);}
                if(failure==null)failure=(sent>0?"PARTIAL_SEND:":"SEND_FAILED:")+(reason==null?"UNKNOWN":reason);
            }
            else if(sent==total){status=received==total?"delivered":"sent";if(deliveryFailed>0)failure="DELIVERY_FAILED";}
            ContentValues m=new ContentValues();m.put("status",status);m.put("updated_at",now());if(failure!=null)m.put("failure_code",failure);
            db.update("messages",m,"id=? AND attempt_id=?",new String[]{id,attempt});
            if(!status.equals(before)||sent==total||failed>0)event(db,device,id,status,total,sent,received,failure);
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    synchronized void terminal(String device,String id,String status,String reason) throws Exception {terminal(getWritableDatabase(),device,id,status,reason);}
    private void terminal(SQLiteDatabase db,String device,String id,String status,String reason)throws Exception{
        boolean handed=false;
        try(Cursor current=db.rawQuery("SELECT status FROM messages WHERE id=? AND device_id=?",new String[]{id,device})){if(current.moveToFirst())handed=!"staged".equals(current.getString(0));}
        ContentValues m=new ContentValues();m.put("status",status);m.put("updated_at",now());if(reason!=null)m.put("failure_code",reason);
        if(db.update("messages",m,"id=? AND device_id=? AND status IN ('staged','queued','processing')",new String[]{id,device})>0&&handed)event(db,device,id,status,0,0,0,reason);
    }
    synchronized JSONArray events(String device) throws Exception {
        JSONArray result=new JSONArray();try(Cursor c=getReadableDatabase().rawQuery("SELECT payload FROM events WHERE device_id=? ORDER BY sequence LIMIT 100",new String[]{device})){while(c.moveToNext())result.put(new JSONObject(c.getString(0)));}return result;
    }
    synchronized void eventsAcknowledged(String device,JSONArray ids)throws Exception{
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{for(int i=0;i<ids.length();i++)db.delete("events","device_id=? AND id=?",new String[]{device,ids.getString(i)});db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    synchronized JSONArray history(String device)throws Exception{
        JSONArray result=new JSONArray();try(Cursor c=getReadableDatabase().rawQuery("SELECT * FROM messages WHERE device_id=? ORDER BY created_at DESC LIMIT 100",new String[]{device})){while(c.moveToNext())result.put(record(c));}return result;
    }
    synchronized int count(String device,String statuses) {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM messages WHERE device_id=? AND status IN ("+statuses+")",new String[]{device})){return c.moveToFirst()?c.getInt(0):0;}
    }
    synchronized boolean blocked(String device,String phone){try(Cursor c=getReadableDatabase().rawQuery("SELECT phone FROM blocklist WHERE device_id=? AND phone=?",new String[]{device,phone})){return c.moveToFirst();}}
    synchronized void block(String device,String phone){ContentValues v=new ContentValues();v.put("device_id",device);v.put("phone",phone);getWritableDatabase().insertWithOnConflict("blocklist",null,v,SQLiteDatabase.CONFLICT_IGNORE);}
    synchronized void unblock(String device,String phone){getWritableDatabase().delete("blocklist","device_id=? AND phone=?",new String[]{device,phone});}
    synchronized ArrayList<String> blocks(String device){ArrayList<String> r=new ArrayList<>();try(Cursor c=getReadableDatabase().rawQuery("SELECT phone FROM blocklist WHERE device_id=? ORDER BY phone",new String[]{device})){while(c.moveToNext())r.add(c.getString(0));}return r;}
}
