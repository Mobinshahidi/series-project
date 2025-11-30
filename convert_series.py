import sys, json

path = sys.argv[1] if len(sys.argv) > 1 else "series.txt"

items = []
with open(path, "r", encoding="utf-8") as f:
    for i, line in enumerate(f, start=1):
        line = line.strip()
        if not line:
            continue
        if " — " in line:
            title, year_str = line.split(" — ", 1)
            title = title.strip()
            year_str = year_str.strip()
            try:
                year = int(year_str)
            except ValueError:
                year = None
        else:
            title = line
            year = None
        items.append({
            "id": str(i),
            "title": title,
            "year": year,
            "rating": 0
        })

json.dump(items, sys.stdout, ensure_ascii=False, indent=2)

