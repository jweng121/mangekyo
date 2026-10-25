"""Sender-specific document content and deterministic print/scan layouts."""
import hashlib
import io
import random
import re
from datetime import date, timedelta
from decimal import Decimal
from xml.sax.saxutils import escape
import fitz
from PIL import Image, ImageDraw
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
from reportlab.lib.utils import ImageReader

FIRM = 'Hartwell & Moreno LLP'
FOOTER = 'FICTIONAL DEMO RECORD - NOT FOR PAYMENT OR LEGAL USE'
INK = colors.HexColor('#253747')
TEAL = colors.HexColor('#245c66')

def money(n):
    return f'{"-" if n < 0 else ""}${abs(n)//100:,}.{abs(n)%100:02}'

def monetary(text):
    return sorted(set(int(Decimal(v.replace('$', '').replace(',', ''))*100)
                      for v in re.findall(r'-?\$[\d,]+\.\d{2}', text)))

def enrich_documents(data, docs):
    """Add detail without changing any existing totals, outcomes or approvals."""
    byid = {d['id']: d for d in docs}
    for inv in data['invoices']:
        original=inv['lines'][0]
        if 'hoursTenths' in original:
            first=4
            inv['lines']=[dict(description='Review records and prepare case notes',hoursTenths=first,rateCents=original['rateCents'],amountCents=first*original['rateCents']//10),
                          dict(description='Client conference and written follow-up',hoursTenths=original['hoursTenths']-first,rateCents=original['rateCents'],amountCents=(original['hoursTenths']-first)*original['rateCents']//10)]
        elif inv['id']=='cho-expert-invoice':
            inv['lines']=[dict(description='Site inspection and measurements',quantity=3,unitCents=75000,amountCents=225000),
                          dict(description='Expert analysis and testimony preparation',quantity=5,unitCents=75000,amountCents=375000)]
        for i,line in enumerate(inv['lines']):
            line['serviceDate'] = str(date.fromisoformat(inv['date']) - timedelta(days=len(inv['lines'])-i))
    byletter = {l['id']: l for l in data['lien-letters']}
    for letter in data['lien-letters']:
        total = letter['amountCents']
        # The revised quote includes the same original services plus a late charge.
        prior = byletter.get(letter.get('supersedes'))
        base = 1200000 if letter['id'] in ['bayside-v1', 'bayside-v2'] else prior['amountCents'] if prior else total
        first = base * 3 // 5
        charges = [dict(serviceDate='2026-02-18',description='Clinical evaluation and diagnostic imaging',
                        billedCents=first+125000,adjustmentCents=125000,payoffCents=first),
                   dict(serviceDate='2026-03-10',description='Outpatient treatment and follow-up care',
                        billedCents=base-first+75000,adjustmentCents=75000,payoffCents=base-first)]
        if letter['id']=='bayside-v2':
            charges.append(dict(serviceDate='2026-04-02',description='Supplemental therapy charge; posted 10/21/2026',
                                billedCents=300000,adjustmentCents=50000,payoffCents=250000))
        elif total != base:
            # Other revisions re-quote the same services: a later charge added, or a further negotiated reduction.
            posted = date.fromisoformat(letter['date']).strftime('%m/%d/%Y')
            if total > base:
                extra = total-base
                charges.append(dict(serviceDate='2026-04-02',description='Supplemental therapy charge; posted '+posted,
                                    billedCents=extra+extra//5,adjustmentCents=extra//5,payoffCents=extra))
            else:
                charges[0]['adjustmentCents'] += base-total; charges[0]['payoffCents'] -= base-total
                charges[0]['description'] += '; further reduction posted '+posted
        letter['charges'] = charges
        letter['totalBilledCents'] = sum(c['billedCents'] for c in charges)
        letter['totalAdjustmentCents'] = sum(c['adjustmentCents'] for c in charges)
        d = byid[letter['id']]
        d['amountCents'] += [letter['totalBilledCents'],letter['totalAdjustmentCents']]
        d['amountCents'] += [c[k] for c in charges for k in ['billedCents','adjustmentCents','payoffCents']]
    data['bank-statements'] = []
    for rec in data['reconciliations']:
        month = rec['month']; tx = [t for t in data['bank-transactions'] if t['postedDate'].startswith(month)]
        id = 'bank-statement-'+month
        record = dict(id=id,documentId=id,month=month,account='****4417',
                      openingBalanceCents=rec['openingBalanceCents'],closingBalanceCents=rec['bankEndingCents'],
                      creditsCents=sum(max(t['amountCents'],0) for t in tx),
                      debitsCents=sum(max(-t['amountCents'],0) for t in tx),transactionIds=[t['id'] for t in tx])
        data['bank-statements'].append(record)
        docs.append(dict(id=id,kind='bank_statement',title='Client Trust Account Statement',issuer='Bay Commerce Bank',
                         date=month+'-'+str(__import__('calendar').monthrange(int(month[:4]),int(month[5:]))[1]),
                         body=[],scanned=False,pdf=f'documents/{id}.pdf',text=f'documents/{id}.txt',
                         amountCents=[record[k] for k in ['openingBalanceCents','closingBalanceCents','creditsCents','debitsCents']]+
                         [abs(t['amountCents']) for t in tx]+[t['balanceCents'] for t in tx]))
    for d in docs:
        if d['id'].startswith('title-'):
            d['issuer']='Estuary Title Services'
            d['title']='Escrow Wire Confirmation'
        d['notes'] = ['review payoff - SW', 'copy to matter file - RO'] if d['id']=='bayside-v2' else (
            ['signed copy - RO'] if d['id'] in ['fee-c02','fee-c03','allocation-global'] else [])
        d['receivedStamp'] = d['scanned'] and (d['kind'] in ['lien_letter','check','fee_agreement'] or
                            int(hashlib.sha256(d['id'].encode()).hexdigest()[:4],16)%4==0)

def family(d):
    if d['kind']=='email': return 'email'
    if d['issuer']=='Bayside Medical Group': return 'medical'
    if d['issuer'].startswith('Conditional Payment'): return 'agency'
    if d['issuer']=='Harborline Mutual Insurance': return 'insurer'
    if d['issuer']=='Estuary Title Services': return 'title'
    if d['issuer']=='Bay Commerce Bank': return 'bank'
    if d['issuer']==FIRM: return 'firm'
    return 'vendor'

def p(text, size=10, font='Helvetica', color=INK, after=7, leading=None):
    return Paragraph(escape(str(text)).replace('\n','<br/>'),ParagraphStyle('body',fontName=font,fontSize=size,
                     leading=leading or size*1.35,textColor=color,spaceAfter=after))

def table(rows,widths,header=True,small=8.5,align_right=()):
    cells=[[p(c,small,after=0,leading=small*1.3) for c in row] for row in rows]
    t=Table(cells,colWidths=widths,repeatRows=1 if header else 0,hAlign='LEFT')
    styles=[('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),
            ('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),6),
            ('BOTTOMPADDING',(0,0),(-1,-1),6),('LINEBELOW',(0,0),(-1,-1),.35,colors.HexColor('#cbd1d4'))]
    if header:
        styles += [('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e9eef0'))]
    for col in align_right:
        for row in range(1 if header else 0,len(cells)):
            cells[row][col].style.alignment=2
    t.setStyle(TableStyle(styles))
    return t

def header_footer(c, document, d):
    f=family(d);page=document.page
    c.saveState();c.setFillColor(INK)
    if f=='medical':
        c.setStrokeColor(TEAL);c.setLineWidth(2);c.circle(66,738,20,stroke=1,fill=0)
        c.setFillColor(TEAL);c.rect(62,725,8,26,fill=1,stroke=0);c.rect(53,734,26,8,fill=1,stroke=0)
        c.setFont('Helvetica-Bold',19);c.drawString(100,746,'BAYSIDE');c.setFont('Helvetica',12);c.drawString(101,729,'MEDICAL GROUP')
        c.setFont('Helvetica',8);c.drawRightString(562,745,'PATIENT FINANCIAL SERVICES');c.drawRightString(562,731,'726 Lantern Wharf, Suite 230')
        c.drawRightString(562,719,'Oakland, CA 94607');c.drawRightString(562,707,'Telephone: (510) 555-0186')
        c.setStrokeColor(TEAL);c.line(48,694,564,694)
    elif f=='agency':
        c.setFillColor(colors.HexColor('#e5e7e9'));c.rect(42,698,528,70,fill=1,stroke=0)
        c.setFillColor(colors.black);c.setFont('Helvetica-Bold',12);c.drawString(55,748,'FICTIONAL BENEFIT RECOVERY ADMINISTRATION')
        c.setFont('Helvetica',10);c.drawString(55,731,'Conditional Payment Recovery Desk | Training case record')
        c.setFont('Courier',8);c.drawString(55,714,'FORM CP-26    NOT A GOVERNMENT NOTICE    NO REAL BENEFICIARY')
    elif f=='title':
        c.setStrokeColor(colors.HexColor('#82704e'));c.setLineWidth(2)
        c.line(52,731,75,752);c.line(75,752,98,731);c.rect(61,716,28,17,stroke=1,fill=0)
        c.setFont('Times-Bold',21);c.drawString(112,741,'Estuary Title Services')
        c.setFont('Helvetica',8);c.drawString(112,725,'ESCROW OPERATIONS  |  910 Reed Harbor, Oakland, CA 94612')
        c.drawString(112,712,'Telephone: (510) 555-0175  |  Retain with closing file')
        c.line(48,698,564,698)
    elif f=='bank':
        c.setFillColor(colors.HexColor('#173f63'));c.rect(36,712,540,54,fill=1,stroke=0)
        c.setFillColor(colors.white);c.setFont('Helvetica-Bold',21);c.drawString(51,736,'BAY COMMERCE BANK')
        c.setFont('Helvetica',8);c.drawRightString(561,725,'BUSINESS BANKING / TRUST SERVICES')
        c.setFillColor(INK);c.setFont('Helvetica',8);c.drawString(42,698,'1128 Bracken Plaza, Oakland, CA 94612 | Telephone: (510) 555-0120')
    elif f=='email':
        c.setFont('Helvetica-Bold',14);c.drawString(54,747,'Sam Whitfield')
        c.setFont('Helvetica',8);c.drawRightString(558,747,'Thursday, October 22, 2026 4:49 PM')
        c.setStrokeColor(colors.grey);c.line(54,734,558,734)
    elif f=='firm':
        c.setFont('Times-Bold',22);c.drawCentredString(306,749,FIRM)
        c.setFont('Times-Roman',9);c.drawCentredString(306,732,'ATTORNEYS AT LAW')
        c.setFont('Helvetica',8);c.drawCentredString(306,717,'1846 Alder Quay, Suite 400 | Oakland, CA 94612 | Telephone: (510) 555-0147')
        c.setStrokeColor(colors.HexColor('#8a8176'));c.setLineWidth(.7);c.line(58,705,554,705)
    else:
        c.setFont('Times-Bold',18);c.drawString(52,747,d['issuer'])
        c.setFont('Helvetica',8);c.drawString(52,730,'583 Willow Anchorage | Oakland, CA 94612 | Telephone: (510) 555-0131')
        c.setStrokeColor(colors.grey);c.line(52,716,560,716)
    # Stamps and marginal review marks never assert verification or approval.
    if d.get('receivedStamp'):
        c.saveState();c.translate(420,117);c.rotate(-9);c.setStrokeColor(colors.HexColor('#a83b42'));c.setFillColor(colors.HexColor('#a83b42'))
        c.setLineWidth(2.5);c.rect(-4,-9,144,43);c.setFont('Helvetica-Bold',17);c.drawString(4,13,'RECEIVED')
        c.setFont('Helvetica-Bold',10);c.drawString(4,-2,date.fromisoformat(d['date']).strftime('%b %d %Y').upper());c.restoreState()
    for i,note in enumerate(d.get('notes',[])):
        c.saveState();c.translate(63,110-i*18);c.rotate(2-i*4);c.setFont('Times-Italic',12);c.setFillColor(colors.HexColor('#314d83'))
        # Slight per-letter baseline drift provides a pen-like annotation with portable fonts.
        r=random.Random(d['id']+note);x=0
        for ch in note:
            c.drawString(x,r.uniform(-.5,.5),ch);x+=c.stringWidth(ch,'Times-Italic',12)
        c.restoreState()
    c.setFillColor(colors.HexColor('#aaaeb2'));c.setFont('Helvetica',6)
    c.drawString(42,28,FOOTER);c.drawRightString(570,28,f'{d["id"]} | Page {page}')
    c.restoreState()

def content(d,data,width):
    kind=d['kind'];f=family(d)
    story=[]
    if kind!='email':
        story += [p(d['title'],15,'Helvetica-Bold' if f!='firm' else 'Times-Bold',after=5),
                  p('Date: '+d['date']+'    |    Reference: '+d['id'].upper(),8,after=13)]
    if kind=='lien_letter':
        rec=next(r for r in data['lien-letters'] if r['id']==d['id'])
        story += [p(d['body'][0],11,'Helvetica-Bold'),p(d['body'][1]+'    |    Revision '+str(rec['version']),9),
                  p('To: Sam Whitfield, Hartwell & Moreno LLP'),
                  p('The following account detail supports the payoff quotation for your client. Adjustments reflect the negotiated reductions applied to the listed services. This quotation supersedes earlier payoff figures for this account.',10,'Times-Roman')]
        rows=[['Service date / description','Billed','Adjustments','Payoff']]
        for c in rec['charges']:
            rows.append([c['serviceDate']+'\n'+c['description'],money(c['billedCents']),money(c['adjustmentCents']),money(c['payoffCents'])])
        rows.append(['TOTAL',money(rec['totalBilledCents']),money(rec['totalAdjustmentCents']),money(rec['amountCents'])])
        story += [table(rows,[width-225,75,75,75],align_right=(1,2,3)),Spacer(1,12),
                  p('Payoff valid through: '+rec['validThrough'],10,'Helvetica-Bold'),
                  p('Please identify the patient reference on your remittance. Contact the office if payment will arrive after the valid-through date.',9)]
        if f=='medical':
            story += [table([['Remittance instructions on file','Contact'],['Cedar Inlet Bank | Account ****1264\nRouting: withheld in this copy','billing@baysidemedical.com\nTelephone: (510) 555-0186']],[width*.52,width*.48]),
                      p('Sincerely,\nNora Ellis | Accounts Resolution',10,'Times-Roman')]
        else:
            story += [p('Medicare-style conditional payment summary - synthetic claim MC-260318. This fictional training agency is not affiliated with any government program. This form creates no payment obligation and contains no actual beneficiary data.',9),
                      p('Recovery reference: MC-260318 | Remittance account ****6320 | Routing withheld',9),
                      p('Case review officer: Nora Ellis | Fictional Recovery Desk',9)]
    elif kind=='settlement_statement' and d['id'] not in ['settlement-v1','settlement-v2']:
        rec=next(r for r in data['settlement-statements'] if r['id']==d['id'])
        cid=rec['lines'][0]['clientId'];client=next(c['name'] for c in data['clients'] if c['id']==cid)
        matter=next(m['name'] for m in data['matters'] if m['id']==rec['matterId'])
        fee=next(f for f in data['fee-agreements'] if f['clientId']==cid);pct=fee['rateBasisPoints']//100
        lines={l['kind']:l['amountCents'] for l in rec['lines']};gross=rec['grossCents']
        if fee['basis']=='gross':
            rate=f'{pct}% of gross';calc=f'{pct}% x {money(gross)} = {money(lines["attorney_fee"])}'
        else:
            rate=f'{pct}% of net after costs';calc=f'{pct}% x ({money(gross)} - {money(lines["costs"])}) = {pct}% x {money(gross-lines["costs"])} = {money(lines["attorney_fee"])}'
        letter=next((l for l in data['lien-letters'] if l['id']==rec['lienLetterId']),None)
        story += [p(client+' | '+matter,11,'Times-Bold'),
                  p(rec['insurer']+' claim '+rec['claimNumber']+' | Gross recovery: '+money(gross),9),
                  p('SIGNED CLIENT DISTRIBUTION' if not rec['supersedes'] else 'REVISED DISTRIBUTION - CLIENT RE-SIGNED',9,'Helvetica-Bold')]
        if rec['supersedes']:
            prior=next(r for r in data['settlement-statements'] if r['id']==rec['supersedes'])
            old=next(l['amountCents'] for l in prior['lines'] if l['kind']=='lien')
            story.append(p(f'This statement replaces version {prior["version"]} signed {prior["signedDate"]}, which showed the earlier Bayside payoff of {money(old)}. Bayside issued revision {letter["version"]} on {letter["date"]}; the client reviewed the revised payoff and signed again before any distribution.',9,'Times-Roman'))
        story += [table([['Allocation / fee basis','Attorney fee','Costs','Liens','Net to client'],
                         ['100% / '+rate,money(lines['attorney_fee']),money(lines['costs']),money(lines.get('lien',0)),money(lines['client_share'])]],
                        [width-308,77,69,78,84],small=7,align_right=(1,2,3,4)),
                  p('Fee calculation per signed agreement: '+calc,8,after=4),
                  p('Lien payee: '+(f'Bayside Medical Group | payoff letter {letter["id"].upper()}, revision {letter["version"]} dated {letter["date"]}' if letter else 'None')+' | Fees and cost reimbursement payable to Hartwell & Moreno LLP.',7.5,after=4),
                  table([['Client signature: /s/ '+client,'Date: '+rec['signedDate']]],[width*.73,width*.27],header=False,small=9),Spacer(1,7),
                  p('Total distributions: '+money(gross),11,'Helvetica-Bold'),
                  table([['Attorney signature: /s/ Luis Moreno','Date: '+rec['signedDate']]],[width*.73,width*.27],header=False,small=9),Spacer(1,7),
                  p('By signing, the client acknowledges review of the recovery and listed deductions and authorizes distribution as shown, subject to cleared funds and final payment approval. A copy of this statement will be retained in the matter file.',9,'Times-Roman')]
    elif kind=='settlement_statement':
        rec=next(r for r in data['settlement-statements'] if r['id']==d['id'])
        story += [p('Delgado, Reyes & Bello v. Ridgeway Logistics',11,'Times-Bold'),
                  p('Harborline claim HL-50877 | Gross recovery: '+money(sum(a['amountCents'] for a in data['allocation-agreements'][0]['allocations'])),9),
                  p('SIGNED CLIENT DISTRIBUTION' if rec['signed'] else 'DRAFT - CLIENT CONFIRMATION AND SIGNATURES REQUIRED',9,'Helvetica-Bold')]
        allocations=data['allocation-agreements'][0]['allocations']
        for a in allocations:
            cid=a['clientId'];client=next(c['name'] for c in data['clients'] if c['id']==cid)
            lines={l['kind']:l['amountCents'] for l in rec['lines'] if l['clientId']==cid}
            rate='33% of gross' if cid=='c01' else '40% of gross (suit filed)' if cid=='c02' else '25% of gross' if rec['version']==1 else '25% of net after costs'
            lien_name='Bayside Medical Group' if cid=='c01' else 'Medicare conditional payment' if cid=='c02' else 'None'
            block=[p(client+' | Allocation '+money(a['amountCents']),10,'Times-Bold',after=4),
                table([['Allocation / fee basis','Attorney fee','Costs','Liens','Net to client'],
                       [f'{a["basisPoints"]//100}% / '+rate,money(lines['attorney_fee']),money(lines['costs']),money(lines.get('lien',0)),money(lines['client_share'])]],
                       [width-308,77,69,78,84],small=7,align_right=(1,2,3,4)),
                p('Lien payee: '+lien_name+' | Fees and cost reimbursement payable to Hartwell & Moreno LLP.',7.5,after=4),
                table([['Client signature: '+('/s/ '+client if rec['signed'] else '____________________________'),'Date: '+(rec['signedDate'] if rec['signed'] else '____________')]], [width*.73,width*.27],header=False,small=9),Spacer(1,7)]
            story.append(KeepTogether(block))
        story += [p('Total distributions: '+money(sum(a['amountCents'] for a in allocations)),11,'Helvetica-Bold'),
                  table([['Attorney signature: '+('/s/ Luis Moreno' if rec['signed'] else '____________________________'),'Date: '+('2026-10-19' if rec['signed'] else '____________')]], [width*.73,width*.27],header=False,small=9),Spacer(1,7),
                  p('By signing, each client acknowledges review of the allocation and listed deductions and authorizes distribution as shown, subject to cleared funds and final payment approval. A copy of this statement will be retained in the matter file.',9,'Times-Roman')]
    elif kind=='fee_agreement':
        rec=next(r for r in data['fee-agreements'] if r['id']==d['id'])
        client=next(c['name'] for c in data['clients'] if c['id']==rec['clientId'])
        matter=next(m['name'] for m in data['matters'] if m['id']==rec['matterId'])
        story += [p('Client: '+client,11,'Times-Bold'),p('Matter: '+matter,10,'Times-Roman'),p('1. Scope of representation',11,'Times-Bold'),
                  p('Client retains the firm for advice and representation in the matter identified above. The firm will keep the client informed of material developments and provide copies of settlement and billing records on request.',10,'Times-Roman'),
                  p('2. Compensation and calculation of fees',11,'Times-Bold')]
        if rec['clientId']=='c01':
            clause='The attorney fee is thirty-three percent (33%) of the gross recovery allocated to this client. Gross recovery means the amount allocated before deduction of litigation costs, medical liens, or other disbursements. Costs and liens are deducted separately from the client share.'
        elif rec['clientId']=='c02':
            clause='If recovery is obtained before a complaint is filed, the attorney fee is thirty-three percent (33%) of the client\'s gross recovery. Once a complaint is filed, the fee is forty percent (40%) of gross recovery, including a settlement reached after filing and before trial. Filing suit is the event that changes the tier; the fee is not reduced because trial does not occur. Gross recovery is measured before costs and liens.'
        elif rec['clientId']=='c03':
            clause='The attorney fee is twenty-five percent (25%) of NET recovery after deduction of this client\'s allocated litigation costs. First allocate the gross recovery to the client, then subtract the client\'s share of litigation costs, then multiply that remainder by 25%. Medical liens, if any, are paid separately and do not change the stated fee basis. No fee may be calculated on the gross allocation before costs.'
        elif rec['basis']=='gross':
            pct=rec['rateBasisPoints']//100;words={25:'twenty-five',30:'thirty',33:'thirty-three'}[pct]
            clause=f'The attorney fee is {words} percent ({pct}%) of the client\'s gross recovery. Gross recovery means the amount recovered before deduction of litigation costs, medical liens, or other disbursements. Costs and liens are deducted separately from the client share.'
        elif rec['basis']=='net_after_costs':
            pct=rec['rateBasisPoints']//100;words={25:'twenty-five',30:'thirty',33:'thirty-three'}[pct]
            clause=f'The attorney fee is {words} percent ({pct}%) of NET recovery after deduction of the litigation costs advanced for this client. First take the gross recovery, then subtract those costs, then multiply that remainder by {pct}%. Medical liens, if any, are paid separately and do not change the stated fee basis. No fee may be calculated on the gross recovery before costs.'
        else:
            clause=d['body'][2]+' Deposits are advances held in trust, not earned fees on receipt. The client receives an itemized invoice describing the completed work before a fee transfer is made.'
        story += [p(clause,10,'Times-Roman'),p('3. Costs and shared recoveries',11,'Times-Bold'),
                  p('Filing fees, expert charges, records and reporting expenses are accounted for separately. In a jointly represented matter, a signed allocation agreement controls each client\'s share of the recovery and shared costs. Each client retains a separate trust ledger and this individual fee agreement.',10,'Times-Roman'),
                  p('4. Statements and client authorization',11,'Times-Bold'),
                  p('Before a settlement distribution, the firm will provide a statement showing the client allocation, fee basis, costs, liens and net proceeds. Client funds remain in trust until earned fees or authorized expenses are paid. Questions about a statement should be directed to the responsible attorney before approval.',10,'Times-Roman'),
                  Spacer(1,8),p('Client signature: /s/ '+client+'    Date: '+d['date'],10,'Times-Roman'),
                  p('Accepted for the firm: /s/ Luis Moreno    Date: '+d['date'],10,'Times-Roman')]
    elif kind=='invoice':
        inv=next(i for i in data['invoices'] if i['id']==d['id']);client=next(c['name'] for c in data['clients'] if c['id']==inv['clientId'])
        story += [p('Bill to: '+client+' | Matter '+inv['matterId'],10),p('Professional services and authorized charges',10,'Helvetica-Bold')]
        rows=[['Service date','Description','Hours / units','Rate','Amount']]
        for line in inv['lines']:
            qty=f'{line["hoursTenths"]//10}.{line["hoursTenths"]%10} h' if 'hoursTenths' in line else str(line['quantity'])
            rows.append([line['serviceDate'],line['description'],qty,money(line.get('rateCents',line.get('unitCents'))),money(line['amountCents'])])
        story += [table(rows,[75,width-290,65,75,75],small=8.5,align_right=(2,3,4)),Spacer(1,16),
                  p('Total due: '+money(inv['amountCents']),12,'Helvetica-Bold'),p('Approved for trust payment: /s/ Sam Whitfield | '+inv['date'],9),
                  p('Please include the invoice number with your remittance. Payments from trust require the ordinary balance and authorization checks. Retain this invoice with the matter expense records.',9)]
    elif kind=='bank_statement':
        r=next(s for s in data['bank-statements'] if s['id']==d['id'])
        story += [p(FIRM+' | IOLTA ****4417',11,'Helvetica-Bold'),p('Statement period: '+r['month']+'-01 through '+d['date'],9),
                  table([['Opening balance','Deposits / credits','Withdrawals / debits','Closing balance'],
                         [money(r['openingBalanceCents']),money(r['creditsCents']),money(r['debitsCents']),money(r['closingBalanceCents'])]], [width/4]*4,small=8.5),Spacer(1,12)]
        rows=[['Posting date','Description / check reference','Debit','Credit','Balance']]
        for t in data['bank-transactions']:
            if t['id'] not in r['transactionIds']:continue
            amt=t['amountCents'];desc=t['description']+(' / '+t['checkNo'] if t.get('checkNo') else '')
            rows.append([t['postedDate'][5:],desc,money(-amt) if amt<0 else '',money(amt) if amt>0 else '',money(t['balanceCents'])])
        story += [table(rows,[49,width-267,70,70,78],small=7.2,align_right=(2,3,4)),Spacer(1,10),
                  p('Please compare this statement with your account records. This statement reports posted bank activity; it does not certify individual client ledger balances. Questions: (510) 555-0120.',8)]
    elif kind=='email':
        story += [p('BG-50877-D payoff - updated wire details',14,'Helvetica-Bold',after=17),
                  table([['From','Bayside Medical Group <billing@baysidemedlcal.com>'],['Sent','Thursday, October 22, 2026 4:42 PM'],['To','Sam Whitfield <sam@hartwell-moreno.example.test>'],['Subject','BG-50877-D payoff - updated wire details']],[55,width-55],header=False,small=9),Spacer(1,14)]
        banner=table([['[EXTERNAL] This message came from outside Hartwell & Moreno']],[width],header=False,small=9)
        banner.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#fff2cd')),('BOX',(0,0),(-1,-1),.5,colors.HexColor('#d7b467'))]))
        story += [banner,Spacer(1,17)]
        for text in d['body'][4:]:story.append(p(text,10,after=10))
    elif f=='title':
        story += [p('Escrow file: ETS-260707-91 | Jamie Nguyen',11,'Times-Bold'),
                  table([['Transfer field','Confirmation'],['Originator',FIRM+' Client Trust' if d['id']=='title-return' else 'Estuary Title Services'],['Receiving bank','Cedar Inlet Bank' if d['id']=='title-return' else 'Bay Commerce Bank'],['Beneficiary','Estuary Title Services' if d['id']=='title-return' else FIRM+' Client Trust'],['Account',('****9276' if d['id']=='title-return' else '****4417')+' | Routing withheld'],['Reference','ETS-260707-91'],['Value date',d['date']],['Amount',money(d['amountCents'][0])],['Status','Return processed' if d['id']=='title-return' else 'Wire sent / receipt confirmed']],[145,width-145]),Spacer(1,15),
                  p(d['body'][-1],10),p('This confirmation identifies a single transfer. Keep it with the bank advice and closing ledger; a repeated reference alone does not cancel another transfer.',9,'Times-Roman'),p('Prepared by: Escrow Operations | Copy for client trust file',9)]
    else:
        for line in d['body']:story.append(p(line,10,'Times-Roman' if f=='firm' else 'Helvetica'))
    return story

def check_pdf(d):
    out=io.BytesIO();c=canvas.Canvas(out,pagesize=(612,792),invariant=1,pageCompression=1)
    c.setTitle(d['title']);c.setAuthor(d['issuer'])
    c.setFillColor(colors.HexColor('#23485d'));c.rect(36,712,540,54,fill=1,stroke=0)
    c.setFillColor(colors.white);c.setFont('Helvetica-Bold',18);c.drawString(50,743,'HARBORLINE MUTUAL INSURANCE')
    c.setFont('Helvetica',8);c.drawString(50,726,'CLAIMS PAYMENT SERVICES  |  742 Pelican Reach, Suite 210, Oakland, CA 94607')
    c.setFillColor(INK);c.setFont('Helvetica-Bold',10);c.drawString(48,692,'SETTLEMENT PAYMENT ADVICE')
    c.setFont('Helvetica',9);c.drawString(48,674,d['body'][7]);c.drawRightString(564,674,'Issue date: '+d['date'])
    c.setFont('Helvetica',8);c.drawString(48,655,'Payee: Hartwell & Moreno LLP Client Trust | Draft '+d['checkNumber'])
    c.setDash(3,3);c.setStrokeColor(colors.grey);c.line(35,632,577,632);c.setDash()
    c.setFillColor(colors.HexColor('#eef2ec'));c.rect(32,330,548,278,fill=1,stroke=0)
    for x in range(36,578,7):
        c.setStrokeColor(colors.HexColor('#d9e0d8'));c.line(x,334,x,604)
    c.setStrokeColor(INK);c.rect(32,330,548,278,fill=0,stroke=1)
    c.setFillColor(INK);c.setFont('Times-Bold',16);c.drawString(48,578,'Harborline Mutual Insurance')
    c.setFont('Helvetica',8);c.drawString(48,563,'Claims settlement draft | Bay Commerce Bank')
    c.setFont('Helvetica-Bold',11);c.drawRightString(562,580,'No. '+d['checkNumber']);c.setFont('Helvetica',9);c.drawRightString(562,550,d['date'])
    c.setFont('Helvetica',7);c.drawString(48,524,'PAY TO THE');c.drawString(48,514,'ORDER OF')
    c.setFont('Times-Roman',11);c.drawString(105,516,FIRM+' Client Trust');c.line(104,508,433,508)
    c.setFillColor(colors.white);c.rect(440,505,122,26,fill=1,stroke=1);c.setFillColor(INK);c.setFont('Helvetica-Bold',12);c.drawRightString(555,513,money(d['amountCents'][0]))
    c.setFont('Times-Roman',11);c.drawString(48,482,d['body'][5]);c.line(48,474,562,474)
    c.setFont('Helvetica',8);c.drawString(48,445,d['body'][7]);c.drawString(48,428,'Settlement claims account ****6138 | Routing withheld')
    c.setFont('Times-Italic',14);c.drawString(413,414,'Evan Mercer');c.line(392,406,562,406)
    c.setFont('Helvetica',6);c.drawString(407,396,'AUTHORIZED SIGNATURE');c.drawString(48,383,'NON-NEGOTIABLE - FICTIONAL DEMO CHECK')
    c.setFont('Courier',12);c.drawString(52,350,'ACCOUNT ****6138      DRAFT '+d['checkNumber'])
    c.saveState();c.translate(399,259);c.rotate(-10);c.setStrokeColor(colors.HexColor('#a83b42'));c.setFillColor(colors.HexColor('#a83b42'));c.setLineWidth(2.5);c.rect(0,0,149,44)
    c.setFont('Helvetica-Bold',17);c.drawString(6,23,'RECEIVED');c.setFont('Helvetica-Bold',10);c.drawString(6,8,date.fromisoformat(d['date']).strftime('%b %d %Y').upper());c.restoreState()
    c.setFont('Helvetica',6);c.setFillColor(colors.HexColor('#aaaeb2'));c.drawString(42,28,FOOTER);c.drawRightString(570,28,d['id']+' | Page 1')
    c.save();return out.getvalue()

def render(d,data,root):
    f=family(d)
    if d['kind']=='check':clean=check_pdf(d)
    else:
        out=io.BytesIO();margin=42 if f=='bank' else 58 if f=='firm' else 54 if f=='email' else 48
        bottom=150 if d['scanned'] else 52
        top=75 if f=='email' else 112 if f=='bank' else 110 if f=='vendor' else 116
        template=SimpleDocTemplate(out,pagesize=(612,792),leftMargin=margin,rightMargin=margin,
                    topMargin=top,bottomMargin=bottom,invariant=1,pageCompression=1,title=d['title'],author=d['issuer'])
        template.build(content(d,data,612-margin*2),onFirstPage=lambda c,p:header_footer(c,p,d),onLaterPages=lambda c,p:header_footer(c,p,d))
        clean=out.getvalue()
    with fitz.open(stream=clean,filetype='pdf') as original:
        texts=[page.get_text(sort=True) for page in original]
        all_text='\n'.join(texts)
        for n in d['amountCents']:
            assert money(n) in all_text,(d['id'],n,'missing printed amount')
        assert not re.search(r'(?<!\d)0\d{7,9}(?!\d)',all_text),(d['id'],'unmasked bank number')
        assert 'Enclosure: file copy' not in all_text
        d['pageCount']=len(original)
        d['amountCents']=monetary(all_text)
        # Actual clean-PDF extraction, then a harmless OCR slip in the page marker.
        sidecar='\f\n'.join(t.replace('Page ', 'Paqe ',1) for t in texts)
        (root/d['text']).write_text(sidecar,encoding='utf-8',newline='\n')
        if d['scanned']:
            out=io.BytesIO();scan=canvas.Canvas(out,pagesize=(612,792),invariant=1,pageCompression=1)
            scan.setTitle(d['title']);scan.setAuthor(d['issuer'])
            angles=[]
            for i,page in enumerate(original):
                r=random.Random(int(hashlib.sha256((d['id']+str(i)).encode()).hexdigest()[:12],16))
                pix=page.get_pixmap(matrix=fitz.Matrix(1.8,1.8));im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
                paper=Image.frombytes('L',im.size,r.randbytes(im.width*im.height)).convert('RGB')
                im=Image.blend(im,paper,.045)
                shadow=Image.new('RGBA',im.size,(0,0,0,0));draw=ImageDraw.Draw(shadow)
                for x in range(42):draw.line((x,0,x,im.height),fill=(40,34,24,int(55*(1-x/42)**2)))
                im=Image.alpha_composite(im.convert('RGBA'),shadow).convert('RGB')
                angle=r.uniform(.8,1.7)*r.choice([-1,1]);angles.append(round(angle,4))
                im=im.rotate(angle,Image.Resampling.BICUBIC,fillcolor=(240,238,233))
                jpg=io.BytesIO();im.save(jpg,'JPEG',quality=76,optimize=False)
                scan.drawImage(ImageReader(io.BytesIO(jpg.getvalue())),0,0,612,792);scan.showPage()
            scan.save();output=out.getvalue();d['scanRotationDegrees']=angles
        else:output=clean
    (root/d['pdf']).write_bytes(output)
