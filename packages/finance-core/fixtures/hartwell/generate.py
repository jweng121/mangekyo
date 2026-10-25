"""Deterministic offline fixture. Python 3.11; see requirements.txt."""
import calendar, csv, hashlib, io, json, random, textwrap
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
import fitz
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[3]
SEED=44172026
FIRM='Hartwell & Moreno LLP'
PHONE='(510) 555-0147'
ADDRESS='1846 Alder Quay, Suite 400 | Oakland, CA 94612'
DATA={}; DOCS=[]; TX=[]
rng=random.Random(SEED)
def money(n):
    assert type(n) is int
    return f'{"-" if n<0 else ""}${abs(n)//100:,}.{abs(n)%100:02}'
def dump(path,obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
def doc(id,kind,title,issuer,day,body,scanned=False,amounts=(),**extra):
    DOCS.append(dict(id=id,kind=kind,title=title,issuer=issuer,date=day,body=body,scanned=scanned,amountCents=list(amounts),pdf=f'documents/{id}.pdf',text=f'documents/{id}.txt',**extra))
    return id
def signed(name,day):return [f'Signed: /s/ {name}',f'Date: {day}','Signature retained in the matter file.']
def matter(cid):return next(m['id'] for m in DATA['matters'] if cid in m['clientIds'])
def name(cid):return next(c['name'] for c in DATA['clients'] if c['id']==cid)
def tx(id,day,cid,amount,description,evidence,kind,**extra):
    TX.append(dict(id=id,postedDate=day,ledgerDate=day,clientId=cid,matterId=matter(cid) if cid!='firm' else None,amountCents=amount,description=description.upper()[:32],documentIds=evidence,kind=kind,initiatedBy='riley',approvedBy='sam',status='posted',**extra))
def setup():
    names=['Maria Delgado','Tomas Reyes','Ana Bello','Raymond Cho','Daniel Okafor','Jamie Nguyen','Jordan Nguyen','Elena Park','Victor Chen','Nadia Flores','Omar Hassan','Lena Brooks','Isaac Patel','Sofia Rivera','Marcus Reed','Grace Kim','Rosa Alvarez','Ethan Walsh','Amira Saleh','Noah Bennett','Mei Lin','Carlos Vega','Fatima Yusuf','Peter Novak','Lucia Santos','Andre Lewis','Helen Wu','Mateo Cruz','Tessa Morgan','Jamal Price','Anita Shah','Felix Ortiz','Ruth Coleman','Leila Haddad','Simon Blake','Dina Farouk','Adrian Moss','Nina Petrov','Caleb Ross','Iris Tran']
    DATA['firm']=dict(name=FIRM,fictional=True,attorneyCount=12,practiceAreas=['personal injury','real estate','family law'],address=ADDRESS,phone=PHONE,trustAccount=dict(bank='Bay Commerce Bank',type='IOLTA',ending='4417',openingBalanceCents=0),operatingAccount=dict(bank='Bay Commerce Bank',ending='2290'),staff=[dict(id=i,name=n,role=r) for i,n,r in [('diane','Diane Hartwell','partner'),('luis','Luis Moreno','partner'),('priya','Priya Raman','associate'),('riley','Riley Okoro','paralegal'),('sam','Sam Whitfield','paralegal / trust approver')]])
    DATA['clients']=[dict(id=f'c{i+1:02}',name=n,aliases=[n,'Ma. Delgado','Maria Delgado-Ruiz'] if i==0 else [n],email=f'client{i+1:02}@example.test',phone=f'(510) 555-{100+i:04}') for i,n in enumerate(names)]
    subjects=['Okafor retainer dispute','Nguyen property purchase','Nguyen family petition','Park premises injury','Chen lease review','Flores dissolution','Hassan boundary dispute','Brooks collision','Patel custody petition','Rivera purchase escrow','Reed premises injury','Kim support modification','Alvarez tenancy','Walsh collision','Saleh property sale','Bennett dissolution','Lin easement dispute','Vega collision','Yusuf parenting plan','Novak purchase escrow','Santos premises injury','Lewis family petition','Wu property sale']
    matters=[dict(id='m01',name='Delgado, Reyes & Bello v. Ridgeway Logistics',clientIds=['c01','c02','c03'],practiceArea='personal injury',openedDate='2026-01-12',claimNumber='HL-50877',complaintFiledDate='2026-03-03'),dict(id='m02',name='Cho v. Alder Terrace Properties',clientIds=['c04'],practiceArea='real estate',openedDate='2026-04-24')]
    for i,s in enumerate(subjects):matters.append(dict(id=f'm{i+3:02}',name=s,clientIds=[f'c{i+5:02}'],practiceArea=['family law','real estate','personal injury'][i%3],openedDate='2026-04-27'))
    for i in range(28,41):matters[2+i-28]['clientIds'].append(f'c{i:02}')
    DATA['matters']=matters
    DATA['payees']=[dict(id=i,name=n,phone=p,bank=dict(bank=b,account=a,routing='000000000')) for i,n,p,b,a in [('firm',FIRM,PHONE,'Bay Commerce Bank','00002290'),('bayside','Bayside Medical Group','(510) 555-0186','Cedar Inlet Bank','0000831264'),('medicare','Medicare conditional payment (fictional case record)','(800) 555-0132','Bay Commerce Bank','00006320'),('expert','Marlowe Forensic Services','(510) 555-0131','Cedar Inlet Bank','00004610'),('reporter','Quay Court Reporting','(510) 555-0124','Bay Commerce Bank','00004892'),('clerk','Fictional County Filing Desk','(510) 555-0163','Bay Commerce Bank','00004590')]]
    DATA['payees'][1].update(email='billing@baysidemedical.com',verifiedDate='2026-06-10',sourceDocumentIds=['bayside-prior-letter','bayside-prior-confirmation'])
    DATA['fee-agreements']=[]
    for c in DATA['clients']:
        cid=c['id'];mid=matter(cid);did=f'fee-{cid}';basis='gross' if cid in ['c01','c02'] else 'net_after_costs' if cid=='c03' else 'hourly' if int(cid[1:])%2==0 else 'flat'
        terms=dict(id=did,documentId=did,clientId=cid,matterId=mid,signed=True,basis=basis)
        if cid=='c01':terms.update(rateBasisPoints=3300)
        elif cid=='c02':terms.update(tiers=[dict(trigger='before_suit',rateBasisPoints=3300),dict(trigger='complaint_filed',rateBasisPoints=4000)])
        elif cid=='c03':terms.update(rateBasisPoints=2500)
        elif basis=='hourly':terms.update(hourlyRateCents=32500,initialRetainerCents=500000)
        else:terms.update(flatFeeCents=450000,initialRetainerCents=250000,earnedOn='completed milestones invoiced separately')
        wording={'gross':'33% of the client\'s gross recovery.','net_after_costs':'25% of net recovery AFTER deducting this client\'s allocated litigation costs.','hourly':'Time billed at $325.00 per hour. Initial trust retainer $5,000.00.','flat':'Flat fee $4,500.00; initial deposit $2,500.00. Earned only as invoiced milestones are completed.'}[basis]
        if cid=='c02':wording='33% of gross before suit; 40% of gross once a complaint is filed. The filing date controls the tier.'
        day='2026-01-12' if cid in ['c01','c02','c03'] else '2026-04-27'
        doc(did,'fee_agreement','Agreement for Legal Services',FIRM,day,[f'Client: {c["name"]}',f'Matter: {mid}',wording,'Client funds remain in trust until earned or paid for authorized expenses.','Litigation costs are separate from fees. An itemized statement precedes each transfer.','Shared matters keep separate client ledgers and fee agreements.',*signed(c['name'],day),'Accepted: /s/ Luis Moreno'],scanned=True,amounts=[terms[k] for k in ['hourlyRateCents','initialRetainerCents','flatFeeCents'] if k in terms])
        DATA['fee-agreements'].append(terms)
    DATA['invoices']=[];DATA['cost-receipts']=[];DATA['lien-letters']=[]
def invoice(id,cid,day,amount,expert=False):
    fee=next(f for f in DATA['fee-agreements'] if f['clientId']==cid)
    if expert:line=dict(description='Site inspection and expert testimony preparation',quantity=8,unitCents=75000,amountCents=600000)
    elif fee['basis']=='hourly':
        assert amount%3250==0
        line=dict(description='Review records, conference and correspondence',hoursTenths=amount//3250,rateCents=32500,amountCents=amount)
    else:line=dict(description='Completed milestone: review and written advice',quantity=1,unitCents=amount,amountCents=amount)
    DATA['invoices'].append(dict(id=id,documentId=id,clientId=cid,matterId=matter(cid),date=day,amountCents=amount,lines=[line],status='approved',approvedBy='sam'))
    detail=f'{line["hoursTenths"]/10:.1f} hours x $325.00' if 'hoursTenths' in line else f'{line["quantity"]} x {money(line["unitCents"])}'
    doc(id,'invoice',f'Invoice {id.upper()}','Marlowe Forensic Services' if expert else FIRM,day,[f'Bill to: {name(cid)}',f'Matter: {matter(cid)}',line['description'],detail+'     '+money(amount),'Total due: '+money(amount),'Approved for trust payment: /s/ Sam Whitfield','Please include the invoice number with your remittance.'],scanned=expert,amounts=[amount,line.get('rateCents',line.get('unitCents'))])
    return id
def receipt(id,cid,day,amount,label,issuer='Quay Court Reporting'):
    DATA['cost-receipts'].append(dict(id=id,documentId=id,clientId=cid,matterId=matter(cid),date=day,amountCents=amount,description=label,paidBy='firm operating'))
    doc(id,'receipt','Receipt / Paid Invoice',issuer,day,[f'File: {matter(cid)}',label,'Amount received: '+money(amount),'Paid by Hartwell & Moreno LLP, operating account ending 2290.','Retain this receipt with your case records.'],scanned=True,amounts=[amount])
    return id
def lien(id,cid,day,amount,version,valid,account):
    issuer='Bayside Medical Group' if cid!='c02' else 'Conditional Payment Recovery Desk (fictional)'
    body=[f'Patient: {name(cid)}',f'Patient account: {account}',f'Lien payoff, revision {version}: {money(amount)}',f'Payoff valid through: {valid}','This amount replaces any earlier payoff quotation for this account.','Include the patient account number on the remittance.']
    if cid!='c02':body+=['Bank on file: Cedar Inlet Bank','Routing: 000000000   Account: 0000831264','Billing: billing@baysidemedical.com','Confirm instructions at (510) 555-0186.']
    else:body+=['Program reference: Medicare conditional payment; synthetic claim MC-260318.','No real beneficiary or agency record is represented.']
    body+=['Sincerely,','/s/ Nora Ellis, Accounts Resolution']
    doc(id,'lien_letter','Final Payoff Letter',issuer,day,body,scanned=True,amounts=[amount])
    DATA['lien-letters'].append(dict(id=id,documentId=id,clientId=cid,date=day,amountCents=amount,version=version,validThrough=valid,patientAccount=account,payeeId='medicare' if cid=='c02' else 'bayside'))
def history():
    clients=DATA['clients'][4:]
    for month in range(5,11):
        for j in range(8):
            c=clients[((month-5)*8+j)%len(clients)];cid=c['id'];prefix=f'h{month:02}-{j+1:02}'
            start=f'2026-{month:02}-{2+j*3:02}';amount=500000+rng.randrange(0,90000);method=['ZELLE','ACH','WIRE','CHECK'][j%4];memo=['retainer','part pmt','for file','retianer'][j%4]
            did=doc(prefix+'-deposit','remittance','Client Payment Advice',c['name'],start,[f'To: {FIRM}',f'Client reference: {cid}',f'Amount: {money(amount)}',f'Method: {method}',f'Memo: {memo}','Please credit my trust ledger. This is an advance toward fees and costs.'],scanned=j%2==0,amounts=[amount])
            tx(prefix+'-in',start,cid,amount,f'{method} FROM {c["name"]}',[did],'retainer',checkNo=str(6100+(month-5)*8+j) if method=='CHECK' else '')
            day=f'2026-{month:02}-{3+j*3:02}';fee=3250*(10+j) if int(cid[1:])%2==0 else 42500+j*125
            inv=invoice(prefix+'-invoice',cid,day,fee)
            tx(prefix+'-fee',day,cid,-fee,'ACH TO HARTWELL OPER 2290',[inv],'attorney_fee',payeeId='firm')
            day=f'2026-{month:02}-{4+j*3:02}';expense=12785+j*317
            if j%3==0:
                proof=doc(prefix+'-refund','authorization','Client Refund Authorization',FIRM,day,[f'Client: {c["name"]}',f'Return unused advance: {money(expense)}','Client requested return of the excess installment.',*signed(c['name'],day)],amounts=[expense])
                tx(prefix+'-out',day,cid,-expense,f'ACH REFUND {c["name"]}',[proof],'refund',payeeId=cid)
            else:
                proof=receipt(prefix+'-cost',cid,day,expense,'Certified transcript and delivery')
                tx(prefix+'-out',day,cid,-expense,'ACH COST REIMB OPER 2290',[proof],'costs',payeeId='firm')
    for id,day,amount in [('cho-retainer','2026-05-05',180000),('cho-topup','2026-10-30',520000)]:
        doc(id,'remittance','Trust Deposit Advice','Raymond Cho',day,['Client: Raymond Cho','Matter: Cho v. Alder Terrace Properties','Payment: '+money(amount),'Memo: expert costs / retainer'],scanned=True,amounts=[amount])
        tx(id,day,'c04',amount,'ACH CR RAYMOND CHO',[id],'retainer')
    inv=invoice('cho-expert-invoice','c04','2026-10-08',600000,expert=True)
    tx('cho-expert-payment','2026-10-09','c04',-600000,'CHECK 7074 MARLOWE FORENSIC',[inv],'costs',payeeId='expert',checkNo='7074')
    for id,day,amount in [('title-wire-1','2026-07-07',734125),('title-wire-2','2026-07-08',734125),('title-return','2026-07-10',-734125)]:
        doc(id,'bank_advice','Wire Transfer Advice','Bay Commerce Bank',day,['Originator: Estuary Title Services','Reference: ETS-260707-91','Beneficiary file: Nguyen property purchase / Jamie Nguyen','Amount: '+money(abs(amount)),'Duplicate received in error; return approved by sender.' if amount<0 else 'Purpose: closing funds'],amounts=[abs(amount)])
        tx(id,day,'c06',amount,'WIRE '+('OUT' if amount<0 else 'IN')+' ESTUARY TITLE ETS91',[id],'duplicate_return' if amount<0 else 'closing_wire',reference='ETS-260707-91',payeeId='title')
    for id,day,amount in [('bank-service-fee','2026-08-18',-2500),('firm-fee-replacement','2026-08-19',2500)]:
        doc(id,'bank_letter','Account Service Notice','Bay Commerce Bank',day,['Account: IOLTA ending 4417','Service charge: '+money(abs(amount)) if amount<0 else 'Operating transfer to replace service charge: '+money(amount),'Charge belongs to the firm; no client ledger is charged.'],amounts=[abs(amount)])
        tx(id,day,'firm',amount,'MONTHLY SERVICE CHARGE' if amount<0 else 'ACH CR HARTWELL OPER 2290',[id],'bank_fee' if amount<0 else 'firm_replacement',payeeId='bank')
    lien('bayside-prior-letter','c08','2026-06-08',320075,1,'2026-06-30','BG-61104')
    doc('bayside-prior-confirmation','bank_advice','Executed Wire Confirmation','Bay Commerce Bank','2026-06-12',['Beneficiary: Bayside Medical Group','Bank: Cedar Inlet Bank','Account: 0000831264','Routing: 000000000','Client: Elena Park / Account BG-61104','Wire amount: $3,200.75','Status: settled; beneficiary acknowledged receipt.'],amounts=[320075])
    doc('park-funding','remittance','Client Payment Advice','Elena Park','2026-06-11',['Funds for medical payoff: $3,200.75','File: Park premises injury'],scanned=True,amounts=[320075])
    tx('park-funding','2026-06-11','c08',320075,'ACH CR ELENA PARK',['park-funding'],'retainer')
    tx('bayside-prior-paid','2026-06-12','c08',-320075,'WIRE OUT BAYSIDE MED GRP',['bayside-prior-letter','bayside-prior-confirmation'],'lien',payeeId='bayside',bankAccount='0000831264')
    for id,day,amount in [('brooks-settlement','2026-09-15',1867341),('brooks-client-payment','2026-09-17',-1867341)]:
        doc(id,'settlement_advice','Property Damage Settlement','Tidemark Casualty Cooperative',day,['Client: Lena Brooks','Property damage only; legal fee waived for this recovery.',f'Gross and net recovery: {money(abs(amount))}','Authorized payment in full to Lena Brooks.',*signed('Lena Brooks',day)],amounts=[abs(amount)])
        tx(id,day,'c12',amount,'CHECK TIDEMARK CASUALTY' if amount>0 else 'ACH TO LENA BROOKS',[id],'settlement' if amount>0 else 'client_share',checkNo='8032' if amount>0 else '',payeeId='c12')
    for i,cid in enumerate(['c06','c07','c05','c05']):
        id=f'noise-{i+1}';day=['2026-05-19','2026-06-18','2026-09-21','2026-10-20'][i];amount=[87525,92040,125000,87500][i]
        doc(id,'remittance','Payment Receipt',FIRM,day,[f'Client confirmed by portal receipt: {name(cid)}',f'Amount: {money(amount)}','Memo: for file' if i<2 else 'Memo: partial retainer; remaining balance to follow.'],amounts=[amount])
        tx(id,day,cid,amount,'ZELLE FROM J NGUYEN' if i<2 else 'ACH CR D OKAFOR PART PMT',[id],'partial_retainer' if i>1 else 'retainer')
def check(id,day,amount,words,memo,number):
    doc(id,'check','Settlement Draft','Harborline Mutual Insurance',day,['742 Pelican Reach, Suite 210 | Oakland, CA 94607',f'Check No. {number}',f'Date: {day}',f'Pay to the order of: {FIRM} Client Trust',f'Amount: {money(amount)}',words+' dollars','Drawn on: Bay Commerce Bank',f'Memo: {memo}','Authorized signature: /s/ Evan Mercer','NON-NEGOTIABLE - FICTIONAL DEMO CHECK'],scanned=True,amounts=[amount],checkNumber=number)
def live():
    doc('complaint-filed','court_filing','Endorsed Complaint','Fictional Superior Court - Civil Division','2026-03-03',['Delgado, Reyes & Bello v. Ridgeway Logistics','Case: CV-26-0303-184','FILED: March 3, 2026','Complaint for damages arising from a truck collision.','Claim No. 50877','Submitted by Priya Raman for plaintiffs.','Clerk endorsement: 03/03/2026 09:14 AM'],scanned=True)
    alloc=[dict(clientId=cid,basisPoints=bp,amountCents=amt,costCents=cost) for cid,bp,amt,cost in [('c01',5000,6250000,225000),('c02',3000,3750000,135000),('c03',2000,2500000,90000)]]
    DATA['allocation-agreements']=[dict(id='allocation-global',documentId='allocation-global',matterId='m01',signed=True,date='2026-10-15',grossCents=12500000,sharedCostCents=450000,allocations=alloc)]
    doc('allocation-global','allocation_agreement','Joint Recovery Allocation Agreement',FIRM,'2026-10-15',['Delgado, Reyes & Bello v. Ridgeway Logistics','Harborline claim HL50877; one global recovery of $125,000.00.','Maria Delgado: 50% / $62,500.00; shared costs $2,250.00.','Tomas Reyes: 30% / $37,500.00; shared costs $1,350.00.','Ana Bello: 20% / $25,000.00; shared costs $900.00.','Total shared costs $4,500.00, apportioned in these same percentages.','Supplemental recovery on this claim follows the same 50/30/20 allocation.','Each client retains a separate fee agreement; fees are calculated after allocation.',*signed('Maria Delgado','10/15/2026'),*signed('Tomas Reyes','10/15/2026'),*signed('Ana Bello','10/15/2026')],amounts=[12500000,6250000,3750000,2500000,450000,225000,135000,90000])
    for id,amt,label,issuer in [('global-expert',300000,'Collision reconstruction: 4 hours x $750.00','Marlowe Forensic Services'),('global-reporter',105000,'Deposition transcript and attendance','Quay Court Reporting'),('global-filing',45000,'Civil complaint filing fee','Fictional County Filing Desk')]:
        receipt(id,'c01','2026-10-12',amt,label,issuer);DATA['cost-receipts'][-1].update(clientId=None,allocationAgreementId='allocation-global',shared=True)
    lien('bayside-v1','c01','2026-10-14',1200000,1,'2026-10-20','BG-50877-D')
    lien('bayside-v2','c01','2026-10-21',1450000,2,'2026-11-15','BG-50877-D')
    lien('reyes-conditional','c02','2026-10-14',320000,1,'2026-11-15','MC-260318')
    DATA['settlement-statements']=[]
    for version in [1,2]:
        lines=[];values=[('c01',[2062500,225000,1200000 if version==1 else 1450000,2762500 if version==1 else 2512500]),('c02',[1500000,135000,320000,1795000]),('c03',[625000 if version==1 else 602500,90000,0,1785000 if version==1 else 1807500])]
        for cid,vals in values:
            for kind,amt in zip(['attorney_fee','costs','lien','client_share'],vals):
                if amt:lines.append(dict(clientId=cid,kind=kind,amountCents=amt,payeeId='firm' if kind in ['attorney_fee','costs'] else ('bayside' if cid=='c01' else 'medicare') if kind=='lien' else cid))
        id=f'settlement-v{version}';day='2026-10-19' if version==1 else '2026-10-22'
        DATA['settlement-statements'].append(dict(id=id,documentId=id,matterId='m01',version=version,signed=version==1,signedDate=day if version==1 else None,date=day,grossCents=12500000,lines=lines,allocationAgreementId='allocation-global',sourceDocumentIds=['fee-c01','fee-c02','fee-c03','complaint-filed','global-expert','global-reporter','global-filing',f'bayside-v{version}','reyes-conditional']))
        body=['Delgado, Reyes & Bello v. Ridgeway Logistics','Claim HL-50877 | Gross recovery: $125,000.00','Approved distribution' if version==1 else 'DRAFT - CLIENT CONFIRMATION AND SIGNATURES REQUIRED']
        for cid,vals in values:
            body+=[name(cid)+' | Allocation '+money(sum(vals))]
            for kind,amt in zip(['Attorney fee','Costs reimbursed to firm','Medical lien','Net to client'],vals):
                if amt:body+=[f'    {kind}: {money(amt)}']
        body+=['Total distributions: $125,000.00','Client signatures:']
        body+=['/s/ Maria Delgado    /s/ Tomas Reyes    /s/ Ana Bello','Signed October 19, 2026'] if version==1 else ['Maria Delgado: __________________  Date: __________','Tomas Reyes: _____________________  Date: __________','Ana Bello: _______________________  Date: __________']
        doc(id,'settlement_statement',f'Settlement Statement - Version {version}',FIRM,day,body,amounts=[12500000]+[l['amountCents'] for l in lines]+[6250000,3750000,2500000])
    check('global-check','2026-10-22',12500000,'One hundred twenty-five thousand and 00/100','Claim HL-50877 global settlement','902174')
    check('supplemental-check','2026-11-06',500000,'Five thousand and 00/100','Supplemental claim HL50877','902618')
    DATA['incoming-items']=[dict(id='incoming-global',documentId='global-check',receivedDate='2026-10-22',amountCents=12500000,matterId='m01',claimNumber='HL-50877',status='pending_deposit',scenario='live'),dict(id='incoming-supplement',documentId='supplemental-check',receivedDate='2026-11-06',amountCents=500000,matterId='m01',claimNumber='HL-50877',status='not_posted',scenario='november_followup',policyId='policy-hl50877')]
    doc('policy-hl50877','policy','Approved Supplemental Allocation',FIRM,'2026-10-23',['Policy P-HL50877. Scope: supplemental receipts for claim HL-50877 only.','Allocate Maria Delgado 50%, Tomas Reyes 30%, Ana Bello 20%.','Authority: signed October 15 joint allocation agreement.','This policy allocates ownership only. It does not approve fees or payments.','Approved: /s/ Sam Whitfield | October 23, 2026'])
    DATA['policies']=[dict(id='policy-hl50877',documentId='policy-hl50877',status='approved',approvedBy='sam',approvedDate='2026-10-23',claimNumber='HL-50877',allocationAgreementId='allocation-global',allocations=[dict(clientId=a['clientId'],basisPoints=a['basisPoints']) for a in alloc])]
    body=['From: Bayside Medical Group <billing@baysidemedlcal.com>','To: Sam Whitfield <sam@hartwell-moreno.example.test>','Date: Thu, 22 Oct 2026 16:42:00 -0700','Subject: BG-50877-D payoff - updated wire details','Sam,','We changed receiving banks this week. Please send tomorrow\'s $14,500.00 payoff to the account below.','Beneficiary: Bayside Medical Group','Bank: Juniper Channel Bank','Routing: 000000000','Account: 0000975521','The prior account is being closed. Please reply when the transfer has been released.','Thank you,','Nora Ellis | Billing','Bayside Medical Group']
    doc('bayside-bank-change','email','Printed Email',FIRM,'2026-10-22',body,amounts=[1450000],eml='documents/bayside-bank-change.eml')
    DATA['communications']=[dict(id='bayside-bank-change',documentId='bayside-bank-change',receivedAt='2026-10-22T16:42:00-07:00',fromAddress='billing@baysidemedlcal.com',payeeId='bayside',requestedAmountCents=1450000,requestedBank=dict(bank='Juniper Channel Bank',routing='000000000',account='0000975521'),scheduledPaymentDate='2026-10-23')]
    (ROOT/'documents').mkdir(exist_ok=True)
    (ROOT/'documents/bayside-bank-change.eml').write_bytes(('\r\n'.join(body[:4]+['Message-ID: <bg50877-20261022@example.test>','MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','']+body[4:])+'\r\n').encode())
def book():
    TX.sort(key=lambda t:(t['postedDate'],t['id']))
    balance=0;ledgers=defaultdict(int);journal=[];disbursements=[];recs=[]
    for month in range(5,11):
        rows=[];opening=balance
        for t in [t for t in TX if t['postedDate'].startswith(f'2026-{month:02}')]:
            a=t['amountCents'];balance+=a;ledgers[t['clientId']]+=a;t['balanceCents']=balance
            rows.append([date.fromisoformat(t['postedDate']).strftime('%m/%d/%Y'),t['description'],f'{-a//100}.{(-a)%100:02}' if a<0 else '',f'{a//100}.{a%100:02}' if a>0 else '',f'{balance//100}.{balance%100:02}',t.get('checkNo','')])
            journal.append(dict(id='je-'+t['id'],transactionId=t['id'],date=t['ledgerDate'],clientId=t['clientId'],matterId=t['matterId'],documentIds=t['documentIds'],initiatedBy=t['initiatedBy'],approvedBy=t['approvedBy'],lines=[dict(account='asset:trust:4417',debitCents=max(a,0),creditCents=max(-a,0)),dict(account='liability:'+t['clientId'],debitCents=max(-a,0),creditCents=max(a,0))]))
            if a<0:disbursements.append(dict(id='disb-'+t['id'],transactionId=t['id'],date=t['postedDate'],clientId=t['clientId'],matterId=t['matterId'],amountCents=-a,kind=t['kind'],payeeId=t.get('payeeId',t['clientId']),status='posted',documentIds=t['documentIds'],initiatedBy=t['initiatedBy'],approvedBy=t['approvedBy'],**({'bankAccount':t['bankAccount']} if 'bankAccount' in t else {})))
        path=ROOT/f'bank/bay-commerce-4417-2026-{month:02}.csv';path.parent.mkdir(exist_ok=True)
        with path.open('w',newline='',encoding='utf-8') as f:
            writer=csv.writer(f,lineterminator='\n');writer.writerow(['Posting Date','Description','Debit','Credit','Balance','Check No.']);writer.writerows(rows)
        end=f'2026-{month:02}-{calendar.monthrange(2026,month)[1]}'
        r=dict(month=f'2026-{month:02}',openingBalanceCents=opening,bankEndingCents=balance,bookEndingCents=balance,clientLedgerTotalCents=sum(v for k,v in ledgers.items() if k!='firm'),firmLedgerCents=ledgers['firm'],unallocatedCents=0,ledgerBalancesCents=dict(sorted(ledgers.items())),outstandingChecks=[],depositsInTransit=[],adjustedBankCents=balance,matched=True,signedBy='sam',signedDate=str(date.fromisoformat(end)+timedelta(days=1)),documentId=f'recon-{month:02}')
        recs.append(r)
        doc(r['documentId'],'reconciliation','Monthly Three-Way Reconciliation',FIRM,r['signedDate'],[f'Period ended: {end} | Bay Commerce Bank IOLTA ending 4417',f'Opening bank balance: {money(opening)}',f'Closing bank balance: {money(balance)}','Outstanding checks: $0.00 | Deposits in transit: $0.00',f'Adjusted bank balance: {money(balance)}',f'Trust book balance: {money(balance)}',f'Total client subsidiary ledgers: {money(r["clientLedgerTotalCents"])}',f'Firm charge clearing ledger: {money(ledgers["firm"])}','Difference: $0.00',f'Reviewed and signed: /s/ Sam Whitfield | {r["signedDate"]}','This reconciliation compares ending balances; retain daily activity with the working papers.'],amounts=[opening,balance,r['clientLedgerTotalCents'],ledgers['firm'],0])
    disbursements.append(dict(id='planned-bayside',date='2026-10-23',clientId='c01',matterId='m01',amountCents=1450000,kind='lien',payeeId='bayside',status='draft_unapproved',statementId='settlement-v2',documentIds=['bayside-v2','bayside-bank-change'],initiatedBy='riley',approvedBy=None))
    DATA['bank-transactions']=TX;DATA['trust-ledger-entries']=journal;DATA['disbursements']=disbursements;DATA['reconciliations']=recs

def answer_key():
    cases=[dict(id='A',agents=['Trust Compliance Auditor'],expected='flag',documents=['cho-retainer','cho-expert-invoice','cho-topup','recon-10'],transactionIds=['cho-retainer','cho-expert-payment','cho-topup'],beforeCents=180000,paymentCents=600000,minimumCents=-420000,endingCents=100000,negativeFrom='2026-10-09',negativeThrough='2026-10-29',answer='Riley paid $6,000.00 with only $1,800.00 in Cho\'s ledger. The $4,200.00 deficit persists until October 30 despite a matched October close.'),
    dict(id='B1',agents=['Evidence Checker'],expected='flag',documents=['fee-c03','allocation-global','settlement-v1','settlement-v2','global-expert','global-reporter','global-filing'],wrongFeeCents=625000,correctFeeCents=602500,overchargeCents=22500,correctClientCents=1807500,answer='Bello owes 25% of ($25,000.00 - $900.00), not 25% of gross. Obtain signatures on corrected v2 before payout.'),
    dict(id='B2',agents=['Evidence Checker'],expected='flag',documents=['bayside-v1','bayside-v2','settlement-v1','settlement-v2'],oldLienCents=1200000,correctLienCents=1450000,shortfallCents=250000,correctClientCents=2512500,answer='The later Bayside payoff supersedes v1. Paying all v1 lines leaves Delgado\'s ledger at zero and $2,500.00 still owed. Get client confirmation and sign v2.'),
    dict(id='B3',agents=['Evidence Checker'],expected='accept',documents=['fee-c02','complaint-filed','allocation-global','settlement-v1'],feeCents=1500000,rateBasisPoints=4000,answer='Reyes\'s 40% gross tier is correct: the complaint was filed March 3 before settlement.'),
    dict(id='C',agents=['Disbursement','Evidence Checker'],expected='hold',documents=['bayside-bank-change','bayside-v2','bayside-prior-letter','bayside-prior-confirmation'],onFileAccount='0000831264',requestedAccount='0000975521',onFileDomain='baysidemedical.com',senderDomain='baysidemedlcal.com',phone='(510) 555-0186',answer='Payee bank details changed by email 1 day before payment; sender domain does not match; hold and verify by phone using the number on file. Do not use contact details from the email.'),
    dict(id='D',agents=['Trust Intake'],expected='allocate_with_policy',documents=['supplemental-check','allocation-global','policy-hl50877'],amountCents=500000,allocationsCents={'c01':250000,'c02':150000,'c03':100000},answer='Use approved claim-scoped policy P-HL50877 to allocate 50/30/20; do not infer payout approval.'),
    dict(id='E1',agents=['Trust Intake','Three-Way Reconciler'],expected='duplicate_resolved',documents=['title-wire-1','title-wire-2','title-return'],duplicateCents=734125,answer='Two distinct wires share reference ETS-260707-91. Second receipt was returned July 10; preserve both receipts and the return.'),
    dict(id='E2',agents=['Trust Compliance Auditor','Three-Way Reconciler'],expected='accept_replacement',documents=['bank-service-fee','firm-fee-replacement'],amountCents=2500,answer='Firm replaced the $25.00 bank fee next day. No client was charged; firm clearing ledger returns to zero.'),
    dict(id='E3',agents=['Trust Intake'],expected='resolve_with_receipt',documents=['noise-1','noise-2'],clientIds=['c06','c07'],answer='J NGUYEN is ambiguous in bank text. Portal receipts identify Jamie and Jordan separately; do not merge them.'),
    dict(id='E4',agents=['Trust Intake'],expected='accept_partial',documents=['noise-3','noise-4','fee-c05'],amountsCents=[125000,87500],answer='Okafor\'s partial deposits are separate advances, not a duplicate or a paid-in-full retainer.')]
    dump(ROOT/'answer-key.json',dict(fictional=True,cases=cases))

def render(d):
    out=io.BytesIO();c=canvas.Canvas(out,pagesize=(612,792),invariant=1,pageCompression=1)
    c.setTitle(d['title']);c.setAuthor(d['issuer']);c.setCreator('Hartwell fictional fixture generator')
    check_=d['kind']=='check'
    if check_:
        c.setFillColorRGB(.96,.97,.93);c.rect(32,290,548,434,fill=1,stroke=0)
        c.setStrokeColorRGB(.3,.4,.35);c.rect(38,296,536,422,fill=0,stroke=1)
        for x in range(42,570,12):c.setStrokeColorRGB(.89,.91,.86);c.line(x,300,x,710)
    c.setFillColorRGB(.12,.18,.23);c.setFont('Times-Bold',19 if len(d['issuer'])<43 else 14)
    c.drawString(48,744 if not check_ else 688,d['issuer']);c.setFont('Helvetica',8)
    addr=ADDRESS if d['issuer']==FIRM else '726 Lantern Wharf, Suite 230 | Oakland, CA 94607'
    phone='(510) 555-0186' if d['issuer']=='Bayside Medical Group' else PHONE if d['issuer']==FIRM else '(510) 555-0131'
    c.drawString(48,728 if not check_ else 671,addr);c.drawString(48,715 if not check_ else 658,'Telephone: '+phone)
    c.setStrokeColorRGB(.3,.35,.4);c.line(48,704 if not check_ else 648,564,704 if not check_ else 648)
    c.setFont('Helvetica-Bold',12);c.drawString(48,682 if not check_ else 627,d['title'])
    c.setFont('Helvetica',9);c.drawRightString(564,664 if not check_ else 610,d['date'])
    y=638 if not check_ else 580;fontsize=10 if d['kind']!='settlement_statement' else 9;leading=17 if d['kind']!='settlement_statement' else 16
    for line in d['body']:
        for part in textwrap.wrap(line,width=88 if fontsize==10 else 100,replace_whitespace=False) or ['']:
            assert y>65,(d['id'],'overflow',y)
            c.setFont('Courier' if d['kind']=='email' else 'Times-Roman',fontsize if d['kind']!='email' else 9)
            c.drawString(52,y,part);y-=leading
        y-=3
    if check_:c.setFont('Courier',12);c.drawString(60,310,'|:000000000|:  00004417  ||  '+d['checkNumber'])
    c.setFont('Helvetica',7);c.setFillColorRGB(.4,.4,.4);c.drawString(48,38,'FICTIONAL DEMO RECORD - NOT FOR PAYMENT OR LEGAL USE');c.drawRightString(564,38,d['id']+' | 1');c.drawString(48,26,'Enclosure: file copy');c.save();clean=out.getvalue()
    if d['scanned']:
        pdf=fitz.open(stream=clean,filetype='pdf');pix=pdf[0].get_pixmap(matrix=fitz.Matrix(1.6,1.6));im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples).convert('L')
        seed=int(hashlib.sha256(d['id'].encode()).hexdigest()[:12],16);r=random.Random(seed);angle=r.uniform(.3,1.2)*r.choice([-1,1]);im=im.rotate(angle,Image.Resampling.BICUBIC,fillcolor=249)
        grain=Image.frombytes('L',im.size,r.randbytes(im.width*im.height));im=Image.blend(im,grain,.025);draw=ImageDraw.Draw(im)
        if d['id']=='bayside-v2':draw.text((650,62),'RECEIVED OCT 21 2026',fill=75)
        elif seed%5==0:draw.text((45,15),'FAX RECEIVED  '+d['date']+'  PAGE 01/01',fill=90)
        jpg=io.BytesIO();im.save(jpg,'JPEG',quality=78,optimize=False)
        wrapped=io.BytesIO();scan=canvas.Canvas(wrapped,pagesize=(612,792),invariant=1,pageCompression=1);scan.setTitle(d['title']);scan.setAuthor(d['issuer']);scan.drawImage(ImageReader(io.BytesIO(jpg.getvalue())),0,0,612,792);scan.save();output=wrapped.getvalue();pdf.close()
    else:output=clean
    (ROOT/d['pdf']).write_bytes(output)
    text='\n'.join([d['issuer'],addr,'Teleph0ne: '+phone,d['title'],d['date'],*d['body'],'FICTIONAL DEMO RECORD - NOT FOR PAYMENT OR LEGAL USE','Encl0sure: file copy'])+'\n'
    (ROOT/d['text']).write_text(text,encoding='utf-8')

def main():
    setup();history();live();book();answer_key()
    samples={'bayside-v2':'scanned-lien-letter','settlement-v1':'settlement-statement-v1','global-check':'settlement-check','bayside-bank-change':'fraud-email'}
    screenshot=REPO/'docs/screenshots/hartwell-data';screenshot.mkdir(parents=True,exist_ok=True)
    for d in DOCS:
        render(d)
        if d['id'] in samples:
            with fitz.open(ROOT/d['pdf']) as pdf:pdf[0].get_pixmap(matrix=fitz.Matrix(1.5,1.5)).save(screenshot/(samples[d['id']]+'.png'))
    DATA['documents']=[{k:v for k,v in d.items() if k!='body'} for d in DOCS]
    for n,records in DATA.items():dump(ROOT/f'erp/{n}.json',records)
    files=sorted([*ROOT.glob('bank/*.csv'),*ROOT.glob('erp/*.json'),*ROOT.glob('documents/*'),ROOT/'answer-key.json',*screenshot.glob('*.png')])
    dump(ROOT/'manifest.json',dict(seed=SEED,counts={**{k:len(v) for k,v in DATA.items() if isinstance(v,list)},'scannedPdfs':sum(d['scanned'] for d in DOCS),'screenshots':4},sha256={p.relative_to(REPO).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}))
    print(json.dumps({'transactions':len(TX),'clients':len(DATA['clients']),'matters':len(DATA['matters']),'documents':len(DOCS),'scanned':sum(d['scanned'] for d in DOCS)}))
if __name__=='__main__':main()
