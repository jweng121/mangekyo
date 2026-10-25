"""Local PDF extraction/rendering and parameterized SQLite demo operations.
Input and output are JSON. No credentials are passed to this process.
"""
import sys, json, io, base64, re, sqlite3, uuid
from pathlib import Path
from datetime import datetime, timezone

def pdf_read(request):
 import pdfplumber
 import pypdfium2 as pdfium
 raw=base64.b64decode(request["bytes"], validate=True)
 if len(raw)>20*1024*1024 or not raw.startswith(b"%PDF-"): raise ValueError("Expected a PDF smaller than 20 MB")
 number=request.get("pageNumber",1)
 with pdfplumber.open(io.BytesIO(raw)) as document:
  if not isinstance(number,int) or number<1 or number>len(document.pages): raise ValueError("PDF page does not exist")
  if len(document.pages)>100: raise ValueError("PDF exceeds the 100-page local limit")
  page=document.pages[number-1]
  text=page.extract_text() or ""
  if not text.strip(): raise ValueError("This PDF has no extractable text. Scanned PDFs require OCR, which is not enabled.")
  matches=page.search(request.get("pattern",""),regex=True,case=True,main_group=request.get("group",0)) if request.get("pattern") else []
  region=None;value=None
  if len(matches)==1:
   m=matches[0];value=m["text"];region={"x":m["x0"]/page.width,"y":m["top"]/page.height,"width":(m["x1"]-m["x0"])/page.width,"height":(m["bottom"]-m["top"])/page.height}
  result={"text":text,"pageNumber":number,"pageCount":len(document.pages),"matchCount":len(matches),"value":value,"region":region}
 document=pdfium.PdfDocument(raw);page=document[number-1];image=page.render(scale=1.5).to_pil();out=io.BytesIO();image.save(out,format="PNG")
 result.update({"pngBase64":base64.b64encode(out.getvalue()).decode(),"dimensions":{"width":image.width,"height":image.height}})
 page.close();document.close();return result

def ledger(request):
 path=Path(request["databasePath"]);path.parent.mkdir(parents=True,exist_ok=True)
 db=sqlite3.connect(path,timeout=15);db.row_factory=sqlite3.Row
 try:
  db.executescript("""CREATE TABLE IF NOT EXISTS trust_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, legal TEXT NOT NULL, code TEXT UNIQUE NOT NULL, trust TEXT NOT NULL, invoice TEXT NOT NULL, amount TEXT NOT NULL, account TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allocation_drafts (id TEXT PRIMARY KEY, bankLine TEXT NOT NULL, client TEXT NOT NULL, legalEntity TEXT NOT NULL, liabilityAccount TEXT NOT NULL, invoice TEXT NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, ledgerPosted INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);""")
  rows=[("client-a","Client A","Aster Property Group","A-118","Harbor Trust / Aster","INV-88","$5,000.00","2100-118"),("client-b","Client B","Beacon Development LLC","B-204","Harbor Trust / Beacon","INV-204","$5,000.00","2100-204"),("company-x","Company X","Cedar Facilities","X-310","Harbor Trust / Cedar","INV-310","$3,250.00","2100-310"),("company-y","Company Y","Dune Services","Y-407","Harbor Trust / Dune","INV-407","$7,100.00","2100-407")]
  db.executemany("INSERT OR IGNORE INTO trust_clients VALUES (?,?,?,?,?,?,?,?)",rows);db.commit()
  action=request["action"];stamp=datetime.now(timezone.utc).isoformat()
  if action=="workspace":
   return {"clients":[dict(row) for row in db.execute("SELECT * FROM trust_clients ORDER BY id")],"drafts":[dict(row) for row in db.execute("SELECT * FROM allocation_drafts ORDER BY createdAt DESC")]}
  if action=="read":
   code=request.get("paymentCode")
   records=[dict(row) for row in db.execute("SELECT * FROM trust_clients WHERE code = ? ORDER BY id",(code,))] if code else [dict(row) for row in db.execute("SELECT * FROM trust_clients ORDER BY id")]
   return {"source":"trust_client_register","records":records,"record":{"system":"Harbor Trust / SQLite demo","resource":"trust_clients","operation":"read","status":"succeeded","filters":{"paymentCode":code} if code else {},"columns":[{"key":"name","label":"Client"},{"key":"legal","label":"Legal entity"},{"key":"code","label":"Payment reference"},{"key":"account","label":"Trust account"}],"rows":records,"rowCount":len(records),"truncated":False,"executedAt":stamp}}
  if action not in ("insert","update"): raise ValueError("Unsupported operation")
  db.execute("BEGIN IMMEDIATE")
  client=db.execute("SELECT * FROM trust_clients WHERE name = ?",(request.get("owner"),)).fetchone()
  if not client or request.get("bankLine")!="1042":raise ValueError("Invalid allocation")
  before=None
  if action=="update":
   existing=db.execute("SELECT * FROM allocation_drafts WHERE id = ? AND status = 'draft'",(request.get("draftId"),)).fetchone()
   if not existing: raise ValueError("Draft not found or no longer editable")
   before=dict(existing);draft_id=before["id"]
   db.execute("UPDATE allocation_drafts SET client=?,legalEntity=?,liabilityAccount=?,invoice=?,updatedAt=? WHERE id=?",(client["name"],client["legal"],client["account"],client["invoice"],stamp,draft_id))
  else:
   draft_id="AL-"+str(uuid.uuid4())
   db.execute("INSERT INTO allocation_drafts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",(draft_id,"1042",client["name"],client["legal"],client["account"],client["invoice"],"5000.00","CAD","draft",0,stamp,stamp))
  draft=dict(db.execute("SELECT * FROM allocation_drafts WHERE id=?",(draft_id,)).fetchone());db.commit();draft["ledgerPosted"]=bool(draft["ledgerPosted"])
  changes=[{"field":key,"before":str(before[key]),"after":str(draft[key])} for key in ("client","legalEntity","liabilityAccount","invoice") if before and before[key]!=draft[key]]
  return {"draft":draft,"writeConfirmed":True,"record":{"system":"Harbor Trust / SQLite demo","resource":"allocation_drafts","operation":action,"status":"succeeded","filters":{"id":draft_id},"columns":[{"key":"client","label":"Client"},{"key":"legalEntity","label":"Legal entity"},{"key":"liabilityAccount","label":"Trust account"},{"key":"amount","label":"Amount (CAD)","align":"right"},{"key":"status","label":"Status"}],"rows":[draft],"rowCount":1,"truncated":False,"executedAt":stamp,"changes":changes,"transactionId":draft_id,"postingEffect":"Draft saved. Trust ledger not posted."}}
 finally: db.close()

try:
 request=json.loads(sys.stdin.buffer.read())
 result=pdf_read(request) if request["action"]=="pdf" else ledger(request)
 print(json.dumps(result,ensure_ascii=True))
except Exception as error:
 print(json.dumps({"error":str(error)}));sys.exit(1)
