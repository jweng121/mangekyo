"""Value-only demo scaling. IDs, dates, counts, rates and workflow stay unchanged."""
import csv
import re
from decimal import Decimal

VALUE_SCALE = 150


def scale_values(value, monetary=False):
    if isinstance(value, dict):
        return {k: scale_values(v, monetary or k.endswith('Cents')) for k, v in value.items()}
    if isinstance(value, list):
        return [scale_values(v, monetary) for v in value]
    if type(value) is int and monetary:
        return value * VALUE_SCALE
    if isinstance(value, str):
        return re.sub(r'\$([\d,]+(?:\.\d{2})?)(?!\d)',
                      lambda m: f'${Decimal(m[1].replace(",", "")) * VALUE_SCALE:,.2f}', value)
    return value


def number_words(n):
    small = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
    tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
    if n < 20:
        return small[n]
    if n < 100:
        return tens[n // 10] + ('-' + small[n % 10] if n % 10 else '')
    for divisor, label in [(1000000000, 'billion'), (1000000, 'million'), (1000, 'thousand'), (100, 'hundred')]:
        if n >= divisor:
            return number_words(n // divisor) + ' ' + label + (' ' + number_words(n % divisor) if n % divisor else '')


def scale_bank_files(root):
    for path in root.glob('bank/*.csv'):
        with path.open(newline='', encoding='utf8') as file:
            rows = list(csv.DictReader(file))
        for row in rows:
            for key in ['Debit', 'Credit', 'Balance']:
                if row[key]:
                    row[key] = f'{Decimal(row[key].replace(",", "").replace("$", "")) * VALUE_SCALE:.2f}'
        with path.open('w', newline='', encoding='utf8') as file:
            writer = csv.DictWriter(file, fieldnames=rows[0].keys(), lineterminator='\n')
            writer.writeheader()
            writer.writerows(rows)
