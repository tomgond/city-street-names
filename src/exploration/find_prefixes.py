# -*- coding: utf-8 -*-
import csv
from collections import Counter
import os
from StringIO import StringIO

# Inline TYPE_PREFIXES from norm_data.py
TYPE_PREFIXES = {
    u"רחוב", u"רח", u"רח'", u"שדרות", u"שד", u"שד'", u"דרך", u"כביש",
    u"שביל", u"סמטה", u"מבוי", u"כיכר", u"מעלה", u"ככר", u"מחלף", u"מבוא"
}


def read_csv_rows(path):
    """
    Returns an iterator of row dictionaries from the CSV file.
    Assumes UTF-8 encoding with BOM possibly.
    """
    with open(path, 'rb') as f:
        header_check = f.read(3)
        if header_check == '\xef\xbb\xbf':  # BOM
            f.seek(3)
        else:
            f.seek(0)
        lines = f.readlines()
        decoded_lines = [line.decode('utf-8').rstrip('\r\n') for line in lines]
        if not decoded_lines:
            return
        headers = decoded_lines[0].split(',')
        count = 0
        for line in decoded_lines[1:]:
            parts = line.split(',')
            if len(parts) == len(headers):
                row = dict(zip(headers, parts))
                yield row
                count += 1
                if count >= 1000:
                    break


def find_potential_prefixes(csv_path, min_length=2, max_count=20):
    """
    Analyze the CSV to find potential new TYPE_PREFIXES.
    - Reads original street_name
    - Counts first words not in current TYPE_PREFIXES
    - Filters by minimum length to avoid short artifacts
    - Returns top candidates by frequency
    """
    prefix_counter = Counter()

    try:
        for row in read_csv_rows(csv_path):
            street_name = row.get('street_name', '').strip()
            if street_name:
                tokens = street_name.split()
                if tokens:
                    first_token = tokens[0].strip()
                    # Exclude if too short, or already in TYPE_PREFIXES, not alphabet, or too long (likely proper nouns)
                    if (len(first_token) >= min_length and
                        len(first_token) <= 6 and  # Max length for type prefixes
                        first_token not in TYPE_PREFIXES and
                        first_token.isalnum()):  # Check for alphanumeric
                        prefix_counter[first_token] += 1

    except IOError:
        print("Error: File '%s' not found." % csv_path)
        return []

    # Get top potential prefixes
    top_candidates = prefix_counter.most_common(max_count)
    return top_candidates


if __name__ == "__main__":
    csv_path = 'norm.csv'
    print("Analyzing %s for potential new TYPE_PREFIXES..." % csv_path)

    candidates = find_potential_prefixes(csv_path)

    if candidates:
        print("\nTop %d potential new prefixes (frequency > 0):" %
              len(candidates))
        for word, count in candidates:
            print("Count %d: %s" % (count, repr(word)))
    else:
        print("No new potential prefixes found.")
