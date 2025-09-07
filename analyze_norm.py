import csv
import re

def normalize_text(text):
    """Basic normalization for street names: lowercase, remove non-word chars (including spaces)."""
    return re.sub(r'\W', '', text.lower())

def analyze_norm_csv(file_path, sample_size=1000):
    """Analyze the CSV for normalization issues without loading everything."""
    with open(file_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        headers = next(reader)  # Get headers
        print("Headers:", headers)

        # Find possible original and normalized columns
        orig_col = None
        norm_col = None
        for i, h in enumerate(headers):
            if 'original' in h.lower() or 'name' in h.lower() or 'source' in h.lower():
                orig_col = i
            if 'normalized' in h.lower() or 'norm' in h.lower() or 'std' in h.lower():
                norm_col = i
        print(f"Identified original column index: {orig_col}")
        print(f"Identified normalized column index: {norm_col}")

        if orig_col is None or norm_col is None:
            print("Could not identify original and normalized columns automatically.")
            return

        # Sample analysis
        count = 0
        needs_more = []
        too_much = []
        for row in reader:
            if count >= sample_size:
                break
            if len(row) > max(orig_col, norm_col):
                original = row[orig_col].strip()
                normalized = row[norm_col].strip()
                count += 1

                # Check if normalized is actually normalized (lowercase, no accents)
                expected_norm = normalize_text(original)
                if expected_norm != normalized:
                    if normalized != original.lower():  # If more normalization needed
                        if normalized != expected_norm:
                            needs_more.append((original, normalized, expected_norm))
                        else:
                            too_much.append((original, normalized))
                    else:
                        if normalized != expected_norm:
                            needs_more.append((original, normalized, expected_norm))

        print(f"Sampled {count} rows.")
        print("\nCases needing more normalization:")
        for orig, norm, exp in needs_more[:10]:  # Show first 10
            print(f"Original: '{orig}' -> Normalized: '{norm}' | Expected: '{exp}'")
        if len(needs_more) > 10:
            print(f"... and {len(needs_more)-10} more")

        print("\nCases with too much normalization:")
        for orig, norm in too_much[:10]:
            print(f"Original: '{orig}' -> Normalized: '{norm}'")
        if len(too_much) > 10:
            print(f"... and {len(too_much)-10} more")

if __name__ == "__main__":
    analyze_norm_csv('norm.csv')
