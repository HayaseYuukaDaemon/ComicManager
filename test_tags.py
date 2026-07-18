import tags
import json
import sqlite3

with sqlite3.connect("document-archive.db") as conn:
    cursor = conn.cursor()
    res = cursor.execute('SELECT id, source_meta FROM documents')
    extractor = tags.TagExtractor()
    for index, row in res.fetchall():
        meta = json.loads(row if row else '{}')
        if not meta:
            print(f"Document {index}: source_meta is empty, skipping")
            continue
        tags = extractor.extract_hitomi_tags(meta)
        print(f"Document {index}: tag归一化成功: {len(tags)}个tag")
        