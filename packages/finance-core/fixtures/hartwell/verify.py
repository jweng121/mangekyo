"""Independent checks of committed exports; does not import the generator."""
import csv, hashlib, json, re
from collections import defaultdict
from datetime import date,timedelta
from decimal import Decimal
from email import policy
from email.parser import BytesParser
from pathlib import Path
import fitz
from PIL import Image
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[3]
def load(n):return json.loads((ROOT/n).read_text(encoding='utf-8'))
def dollars(s):return int(Decimal(s.replace('$','').replace(',',''))*100)
def amounts(text):return [dollars(s) for s in re.findall(r'-?\$[\d,]+\.\d{2}',text)]
def check(ok,message):
    if not ok:raise AssertionError(message)
def main():
    data={p.stem:load('erp/'+p.name) for p in (ROOT/'erp').glob('*.json')}
    docs={d['id']:d for d in data['documents']};cases={c['id']:c for c in load('answer-key.json')['cases']}
    clients={c['id'] for c in data['clients']};matters={m['id']:m for m in data['matters']};payees={p['id']:p for p in data['payees']}
    check(len(clients)==40 and len(matters)==25,'client/matter counts')
    check(sum(len(m['clientIds']) for m in matters.values())==40,'every client assigned once')
    for m in matters.values():check(set(m['clientIds'])<=clients,'matter clients')
    fees={f['clientId']:f for f in data['fee-agreements']}
    check(set(fees)==clients,'per-client fee agreements')
    for cid,f in fees.items():check(cid in matters[f['matterId']]['clientIds'] and f['signed'],'fee relationship')
    def walk(value):
        if isinstance(value,dict):
            for k,v in value.items():
                if k.endswith('Cents') and not isinstance(v,(dict,list)):check(type(v) is int,f'integer cents: {k}')
                if k=='documentId':check(v in docs,f'missing document {v}')
                if k in ['documentIds','sourceDocumentIds']:check(set(v)<=docs.keys(),f'missing document references {v}')
                if k=='payeeId':check(v in payees,f'unknown payee {v}')
                walk(v)
        elif isinstance(value,list):
            for v in value:walk(v)
    walk(data)
    txs=data['bank-transactions'];check(len(txs)==160,'160 posted transactions')
    check(len({t['id'] for t in txs})==len(txs),'unique transaction ids')
    bytx={t['id']:t for t in txs};journals={e['transactionId']:e for e in data['trust-ledger-entries']}
    check(set(journals)==set(bytx),'journal coverage')
    invoices={i['id']:i for i in data['invoices']}
    for inv in invoices.values():
        check(sum(l['amountCents'] for l in inv['lines'])==inv['amountCents'],'invoice total')
        for l in inv['lines']:
            expected=l['hoursTenths']*l['rateCents']//10 if 'hoursTenths' in l else l['quantity']*l['unitCents']
            check(expected==l['amountCents'],'invoice line extension')
    for t in txs:
        check(t['status']=='posted' and t['amountCents']!=0,'posted nonzero entry')
        if t['clientId']!='firm':check(t['clientId'] in matters[t['matterId']]['clientIds'],'transaction ownership')
        e=journals[t['id']];lines=e['lines']
        check(sum(l['debitCents'] for l in lines)==sum(l['creditCents'] for l in lines),'balanced journal '+e['id'])
        check(all(l['debitCents']>=0 and l['creditCents']>=0 for l in lines),'nonnegative journal sides')
        check(e['clientId']==t['clientId'] and e['date']==t['ledgerDate'],'journal link')
        check(lines[0]['account']=='asset:trust:4417' and lines[0]['debitCents']-lines[0]['creditCents']==t['amountCents'],'bank leg')
        check(lines[1]['account']=='liability:'+t['clientId'] and lines[1]['creditCents']-lines[1]['debitCents']==t['amountCents'],'client leg')
        if t['kind']=='attorney_fee':
            inv=invoices[t['documentIds'][0]]
            check(inv['amountCents']==-t['amountCents'] and inv['status']=='approved' and inv['clientId']==t['clientId'],'earned fee invoice')
    bank=0;book=0;subs=defaultdict(int,{cid:0 for cid in clients});subs['firm']=0;minimum=defaultdict(int);negatives=set();row_count=0
    for rec in data['reconciliations']:
        month=rec['month'];check(rec['openingBalanceCents']==bank,'opening rollforward')
        with (ROOT/f'bank/bay-commerce-4417-{month}.csv').open(newline='',encoding='utf-8') as f:rows=list(csv.DictReader(f))
        monthly=[t for t in txs if t['postedDate'].startswith(month)]
        check(len(rows)==len(monthly),'CSV count')
        for row,t in zip(rows,monthly):
            delta=dollars(row['Credit'] or '0')-dollars(row['Debit'] or '0');bank+=delta;row_count+=1
            check(bool(row['Debit'])!=bool(row['Credit']),'single bank direction')
            check(delta==t['amountCents'] and dollars(row['Balance'])==bank==t['balanceCents'],'bank running balance')
            check(row['Posting Date']==date.fromisoformat(t['postedDate']).strftime('%m/%d/%Y'),'bank date')
            check(row['Description']==t['description'] and row['Description']==row['Description'].upper() and len(row['Description'])<=32,'bank description')
            check(row['Check No.']==t.get('checkNo',''),'check number')
            e=journals[t['id']];book+=e['lines'][0]['debitCents']-e['lines'][0]['creditCents'];subs[e['clientId']]+=e['lines'][1]['creditCents']-e['lines'][1]['debitCents']
            minimum[e['clientId']]=min(minimum[e['clientId']],subs[e['clientId']])
            if subs[e['clientId']]<0:negatives.add(e['clientId'])
        check(bank==book==sum(subs.values()),'three-way balance '+month)
        check(all(rec[k]==bank for k in ['bankEndingCents','bookEndingCents','adjustedBankCents']),'reported reconciliation '+month)
        check(rec['clientLedgerTotalCents']==sum(v for k,v in subs.items() if k!='firm'),'client control total')
        check(rec['firmLedgerCents']==subs['firm']==0,'firm fee clearing at month end')
        check(rec['ledgerBalancesCents']==dict(subs),'subsidiary balances')
        check(all(v>=0 for v in subs.values()),'all month-end client balances nonnegative')
        check(rec['signedDate']>month+'-31' and rec['signedBy']=='sam' and rec['matched'],'month signed after close')
    check(row_count==160 and negatives=={'c04','firm'},'only deliberate intramonth exceptions')
    a=cases['A'];cho=0;daily={};day=date(2026,5,1)
    while day<=date(2026,10,31):
        cho+=sum(t['amountCents'] for t in txs if t['clientId']=='c04' and t['postedDate']==str(day));daily[str(day)]=cho;day+=timedelta(days=1)
    negative=[d for d,b in daily.items() if b<0]
    check(daily['2026-10-08']==a['beforeCents'] and min(daily.values())==a['minimumCents'] and cho==a['endingCents'],'Cho amounts')
    check(negative[0]==a['negativeFrom'] and negative[-1]==a['negativeThrough'] and len(negative)==21,'Cho negative interval')
    check(bytx['cho-expert-payment']['initiatedBy']=='riley' and -bytx['cho-expert-payment']['amountCents']==a['paymentCents'],'Cho actor/payment')
    allocation=data['allocation-agreements'][0];alloc={a['clientId']:a for a in allocation['allocations']}
    check(allocation['signed'] and sum(a['basisPoints'] for a in alloc.values())==10000,'signed allocation')
    receipts=[r for r in data['cost-receipts'] if r.get('shared')]
    check(sum(r['amountCents'] for r in receipts)==allocation['sharedCostCents']==450000,'shared receipt totals')
    for a in alloc.values():
        check(a['amountCents']==allocation['grossCents']*a['basisPoints']//10000,'gross split')
        check(a['costCents']==allocation['sharedCostCents']*a['basisPoints']//10000,'cost split')
    statements=sorted(data['settlement-statements'],key=lambda s:s['version']);v1,v2=statements
    def line(s,cid,kind):return next(l['amountCents'] for l in s['lines'] if l['clientId']==cid and l['kind']==kind)
    for s in statements:
        check(sum(l['amountCents'] for l in s['lines'])==s['grossCents']==12500000,'statement balances')
        for cid,a in alloc.items():check(sum(l['amountCents'] for l in s['lines'] if l['clientId']==cid)==a['amountCents'],'client split balances')
    check(v1['signed'] and not v2['signed'] and v2['signedDate'] is None,'version signatures')
    correct=(alloc['c03']['amountCents']-alloc['c03']['costCents'])*fees['c03']['rateBasisPoints']//10000;b=cases['B1']
    check(correct==b['correctFeeCents']==line(v2,'c03','attorney_fee'),'Bello net fee')
    check(line(v1,'c03','attorney_fee')==b['wrongFeeCents'] and b['wrongFeeCents']-correct==b['overchargeCents'],'Bello overcharge')
    check(line(v2,'c03','client_share')==b['correctClientCents'],'Bello corrected net')
    liens={l['id']:l for l in data['lien-letters']};b=cases['B2']
    check(liens['bayside-v1']['amountCents']==b['oldLienCents']==line(v1,'c01','lien'),'old lien')
    check(liens['bayside-v2']['date']>v1['signedDate'] and liens['bayside-v2']['amountCents']==b['correctLienCents']==line(v2,'c01','lien'),'new lien')
    check(b['correctLienCents']-b['oldLienCents']==b['shortfallCents'] and line(v2,'c01','client_share')==b['correctClientCents'],'lien impact')
    check(matters['m01']['complaintFiledDate']=='2026-03-03' and matters['m01']['complaintFiledDate']<v1['date'],'complaint before settlement')
    check(fees['c02']['tiers'][1]['rateBasisPoints']==cases['B3']['rateBasisPoints']==4000,'Reyes tier')
    check(line(v1,'c02','attorney_fee')==alloc['c02']['amountCents']*4000//10000==cases['B3']['feeCents'],'Reyes correct fee')
    check(line(v2,'c01','attorney_fee')==alloc['c01']['amountCents']*fees['c01']['rateBasisPoints']//10000,'Delgado fee')
    msg=data['communications'][0];c=cases['C'];onfile=payees['bayside'];email=BytesParser(policy=policy.default).parsebytes((ROOT/docs['bayside-bank-change']['eml']).read_bytes())
    check(email['From'].addresses[0].addr_spec==msg['fromAddress'],'email sender')
    check(msg['fromAddress'].split('@')[1]==c['senderDomain']!=c['onFileDomain']==onfile['email'].split('@')[1],'domain mismatch')
    check(msg['requestedBank']['account']==c['requestedAccount']!=c['onFileAccount']==onfile['bank']['account']==bytx['bayside-prior-paid']['bankAccount'],'bank mismatch')
    check((date.fromisoformat(msg['scheduledPaymentDate'])-date.fromisoformat(msg['receivedAt'][:10])).days==1,'day before payout')
    check(onfile['phone']==c['phone'] and msg['requestedAmountCents']==1450000,'verification contact and amount')
    check('0000975521' in email.get_body().get_content() and '$14,500.00' in email.get_body().get_content(),'email body')
    incoming=data['incoming-items'];policy_=data['policies'][0];d=cases['D']
    check(policy_['status']=='approved' and policy_['approvedBy']=='sam' and policy_['approvedDate']<incoming[1]['receivedDate'],'approved memory')
    check(incoming[1]['amountCents']==d['amountCents']==500000 and incoming[1]['receivedDate'].startswith('2026-11'),'November supplemental')
    check({a['clientId']:a['basisPoints']*d['amountCents']//10000 for a in policy_['allocations']}==d['allocationsCents'],'memory split')
    check(all(t['matterId']!='m01' for t in txs),'live items excluded from posted history')
    check(all(p['status']!='posted' for p in data['disbursements'] if p['matterId']=='m01'),'no unsigned payout posted')
    check(bytx['title-wire-1']['reference']==bytx['title-wire-2']['reference']==bytx['title-return']['reference'],'duplicate wire reference')
    check(bytx['title-wire-1']['amountCents']==bytx['title-wire-2']['amountCents']==-bytx['title-return']['amountCents']==cases['E1']['duplicateCents'],'duplicate return')
    check(-bytx['bank-service-fee']['amountCents']==bytx['firm-fee-replacement']['amountCents']==cases['E2']['amountCents'],'bank fee replaced')
    check([bytx[f'noise-{i}']['clientId'] for i in [1,2]]==cases['E3']['clientIds'],'similar names')
    check([bytx[f'noise-{i}']['amountCents'] for i in [3,4]]==cases['E4']['amountsCents'],'partial payments')
    for case in cases.values():check(set(case['documents'])<=docs.keys() and case['agents'],'answer evidence and agents')
    # Independently read sidecars and PDF pages, and relate document amounts to ERP.
    for group in ['invoices','cost-receipts','lien-letters','incoming-items']:
        for r in data[group]:check(r['amountCents'] in amounts((ROOT/docs[r['documentId']]['text']).read_text(encoding='utf-8')),group+' amount in text')
    for s in statements:
        text=(ROOT/docs[s['documentId']]['text']).read_text(encoding='utf-8')
        check(set([s['grossCents']]+[l['amountCents'] for l in s['lines']])<=set(amounts(text)),'statement amounts in text')
        for cid in alloc:
            clientname=next(c['name'] for c in data['clients'] if c['id']==cid)
            block=text.split(clientname+' | Allocation ')[1].split('Total distributions:')[0].split(' | Allocation ')[0]
            check(all(l['amountCents'] in amounts(block) for l in s['lines'] if l['clientId']==cid),'statement per-client amounts')
    rendered=0
    for id,d in docs.items():
        text=(ROOT/d['text']).read_text(encoding='utf-8')
        check(set(amounts(text))==set(d['amountCents']),'document amount inventory '+id)
        check('Teleph0ne' in text and 'Encl0sure' in text,'two harmless OCR slips '+id)
        with fitz.open(ROOT/d['pdf']) as pdf:
            check(len(pdf)==1,'expected single page '+id)
            page=pdf[0];pix=page.get_pixmap(matrix=fitz.Matrix(.5,.5));check(pix.width>0 and pix.height>0,'PDF render '+id);rendered+=1
            if d['scanned']:check(bool(page.get_images()) and not page.get_text().strip(),'raster scan '+id)
            else:check(set(amounts(page.get_text()))==set(d['amountCents']),'digital PDF amounts '+id)
    for p in (REPO/'docs/screenshots/hartwell-data').glob('*.png'):
        with Image.open(p) as im:im.verify()
    manifest=load('manifest.json')
    for relative,digest in manifest['sha256'].items():check(hashlib.sha256((REPO/relative).read_bytes()).hexdigest()==digest,'content hash '+relative)
    check(len(docs)==221 and sum(d['scanned'] for d in docs.values())==108,'document counts')
    print(json.dumps(dict(result='PASS',clients=40,matters=25,bankTransactions=row_count,matchedMonths=6,pdfPagesRendered=rendered,scannedPdfs=108,answerKeyCases=len(cases),choMinimumCents=minimum['c04'],closingBankCents=bank),indent=2))
if __name__=='__main__':
    import argparse, subprocess, sys
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-determinism',action='store_true',help='Regenerate and require identical manifest and artifact hashes')
    args=parser.parse_args()
    main()
    if args.check_determinism:
        before=(ROOT/'manifest.json').read_bytes()
        subprocess.run([sys.executable,str(ROOT/'generate.py')],check=True)
        check(before==(ROOT/'manifest.json').read_bytes(),'byte-identical regeneration manifest')
        main()
        print('PASS: regeneration preserved all '+str(len(load('manifest.json')['sha256']))+' artifact hashes.')
