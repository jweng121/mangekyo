from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, black, white

OUT = Path(__file__).resolve().parents[3] / "output" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)
W,H=612,792

def text(c,x,y,value,size=9,bold=False):
 c.setFillColor(black);c.setFont("Helvetica-Bold" if bold else "Helvetica",size);c.drawString(x,H-y,value)
def start(name,title,code):
 c=canvas.Canvas(str(OUT/name),pagesize=(W,H));c.setTitle(title);c.setAuthor("Harbor Trust Services - synthetic demo")
 text(c,32,43,title,18);text(c,440,37,"HARBOR TRUST",12,True);text(c,441,50,"Trust & fiduciary services",7)
 c.setFillColor(HexColor("#d8d8d8"));c.rect(32,H-83,548,20,fill=1,stroke=0)
 text(c,40,76,"OFFICE USE ONLY",8,True);text(c,220,76,"Document: "+code,8);text(c,450,76,"Account HT-4821",8)
 return c
def section(c,y,title):
 c.setFillColor(HexColor("#cdcdcd"));c.rect(32,H-y,548,5,fill=1,stroke=0);text(c,34,y+13,title,10,True)
def field(c,x,y,w,label,value):
 c.setStrokeColor(HexColor("#777777"));c.setLineWidth(.5);c.rect(x,H-y-39,w,39,fill=0,stroke=1)
 text(c,x+6,y+11,label,7);c.setFillColor(HexColor("#eff5fb"));c.rect(x+5,H-y-34,w-10,18,fill=1,stroke=0);text(c,x+8,y+29,value,9)
def checks(c,y,options):
 x=38
 for label,checked in options:
  c.setStrokeColor(black);c.setFillColor(HexColor("#eff5fb"));c.rect(x,H-y-12,12,12,fill=1,stroke=1)
  if checked:
   c.setStrokeColor(HexColor("#327340"));c.setLineWidth(1.4);c.line(x+2,H-y-6,x+5,H-y-10);c.line(x+5,H-y-10,x+11,H-y-2)
  text(c,x+17,y+9,label,8);x+=len(label)*4.3+45
def footer(c,code):
 c.setStrokeColor(HexColor("#aaaaaa"));c.setLineWidth(.5);c.line(32,53,580,53)
 text(c,32,752,"Fictional training document. No customer funds or executed signatures.",7)
 text(c,32,763,"Harbor Trust Services / Demonstration only",7);text(c,480,752,code,7);text(c,526,763,"Page 1 of 1",7)
 c.save()

c=start("trust-bank-statement.pdf","Client Trust Account Statement","ST-2026-10")
text(c,32,104,"Statement of receipts and disbursements for funds held on behalf of clients.",9)
section(c,123,"1. ACCOUNT INFORMATION")
field(c,32,143,548,"Account title","Harbor Trust Services / Pooled client trust")
field(c,32,182,274,"Financial institution","Harbor Commercial Bank (fictional)");field(c,306,182,274,"Account number / currency","**** 4821 / CAD")
field(c,32,221,548,"Statement period","October 01 - October 23, 2026")
section(c,280,"2. ACCOUNT SUMMARY")
for i,(label,value) in enumerate([("Opening balance","128,450.00"),("Receipts","15,350.00"),("Disbursements","2,450.00"),("Closing balance","141,350.00")]):field(c,32+i*137,300,137,label,value)
section(c,358,"3. TRANSACTION DETAIL")
xs=[32,65,128,349,420,494,580];labels=["Line","Date","Reference / description","Debit","Credit","Balance"]
c.setFillColor(HexColor("#dddddd"));c.rect(32,H-397,548,20,fill=1,stroke=0)
for x,label in zip(xs,labels):text(c,x+4,390,label,7,True)
rows=[("1040","2026-10-22","Y-407 / Dune retainer","-","7,100.00","135,550.00"),("1041","2026-10-22","TR-1022 / Client disbursement","2,450.00","-","133,100.00"),("1042","2026-10-23","B-204 / Beacon deposit","-","5,000.00","138,100.00"),("1043","2026-10-23","X-310 / Cedar deposit","-","3,250.00","141,350.00")]
for i,row in enumerate(rows):
 y=397+i*28
 for j,value in enumerate(row):
  c.setStrokeColor(HexColor("#999999"));c.setLineWidth(.4);c.rect(xs[j],H-y-28,xs[j+1]-xs[j],28,stroke=1,fill=0);text(c,xs[j]+4,y+17,value,8)
section(c,528,"4. REMITTANCE ADVICE / RECEIPT 1042")
field(c,32,548,548,"Originator","Beacon Development LLC")
field(c,32,587,274,"Payment reference","B-204");field(c,306,587,274,"Trace number","EFT-231042")
field(c,32,626,274,"Receipt amount","CAD 5,000.00");field(c,306,626,274,"Allocation status","Pending client allocation")
checks(c,686,[("Bank receipt verified",True),("Client allocation approved",False),("Ledger posted",False)])
footer(c,"ST-2026-10 / Rev. 10/26")

c=start("trust-funding-instruction.pdf","Trust Account Funding Instruction","TF-0088")
text(c,32,104,"Complete all applicable fields. Include the client reference with your remittance.",9)
section(c,123,"1. ACCOUNT REGISTRATION")
field(c,32,143,548,"Registered client / legal entity","Aster Property Group")
field(c,32,182,274,"Client identifier","Client A");field(c,306,182,274,"Client trust reference","A-118")
checks(c,234,[("Individual",False),("Corporate client",True),("Estate",False),("Personal trust",False)])
field(c,32,260,548,"Account designation","Harbor Trust / Aster")
field(c,32,299,274,"Trust liability account","2100-118");field(c,306,299,274,"Administration file","AST-2026-118")
section(c,358,"2. FUNDING REQUEST")
field(c,32,378,274,"Receivables register reference","INV-88");field(c,306,378,274,"Instruction date","October 01, 2026")
field(c,32,417,274,"Funding amount","CAD 5,000.00");field(c,306,417,274,"Requested receipt date","October 31, 2026")
checks(c,469,[("Electronic funds transfer",True),("Wire transfer",False),("Cheque",False)])
section(c,507,"3. BENEFICIARY AND REMITTANCE")
field(c,32,527,548,"Receiving account","Harbor Trust Services / Account ending 4821")
field(c,32,566,274,"Beneficial owner","Aster Property Group");field(c,306,566,274,"Required payment reference","A-118 / Aster funding")
text(c,36,627,"Allocation instruction",9,True)
text(c,36,644,"Credit the client ledger identified by the remittance reference. An equal amount alone",8)
text(c,36,657,"does not establish ownership. Refer discrepancies to the trust administrator before posting.",8)
field(c,32,678,274,"Prepared by","Client administration / Demo");field(c,306,678,274,"Authorization","Synthetic / Not executed")
footer(c,"TF-0088 / Rev. 10/26")
print(str(OUT))
