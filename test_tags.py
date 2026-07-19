import tags
import json
import sqlite3
from typing import Literal

def test_extract_hitomi_tags():
    with sqlite3.connect("document-archive.db") as source_conn, sqlite3.connect('comics.db') as conn:
        cursor = source_conn.cursor()
        res = cursor.execute('SELECT id, source_meta FROM documents')
        manager = tags.TagManager(conn)
        for index, row in res.fetchall():
            meta = json.loads(row if row else '{}')
            if not meta:
                print(f"Document {index}: source_meta is empty, skipping")
                continue
            extracted_tags = tags.extract_hitomi_tags(meta)
            print(f"Document {index}: tag归一化成功: {len(extracted_tags)}个tag")
        
def test_tag_manager():
    with sqlite3.connect(':memory:') as conn:
        # 创建表
        with open('comic.sql', 'r') as f:
            sql_script = f.read()
        conn.executescript(sql_script)
        manager = tags.TagManager(conn)
        # 测试创建通用标签
        generic_tag = manager.create_generic_tag("Test Tag", tags.TagGroup.Tag)
        assert generic_tag.name == "Test Tag"
        assert generic_tag.tag_group == tags.TagGroup.Tag

        # 测试唯一性
        try:
            manager.create_generic_tag("Test Tag", tags.TagGroup.Tag)
            assert False, "Expected an IntegrityError due to unique constraint"
        except tags.GenericTagExistsError:
            print("Unique constraint enforced correctly for generic tags.")

        class SpecificTagTest(tags.SpecificTag):
            site: Literal[tags.SourceSite.Hitomi] = tags.SourceSite.Hitomi
            fuck: str = "fuck"

            def generalize(self, manager: tags.TagManager) -> tags.GenericTag:
                return tags.GenericTag(name=self.fuck, tag_group=tags.TagGroup.Tag)

        # 测试创建站点特定标签
        hitomi_tag = tags.SpecificTagHitomi(origin_name="test_origin", url="/character/test.html", tag_sex="female", group=tags.TagGroup.Tag)
        assert "site" not in hitomi_tag.specific_field_names()
        assert "site" not in hitomi_tag.dump_specific_fields()
        assert "site" not in json.loads(hitomi_tag.dump_specific_json())
        specific_tag = SpecificTagTest(origin_name="test_origin")
        manager.create_specific_tag(hitomi_tag, generic_tag)
        stored_meta_json = conn.execute(
            "SELECT meta_json FROM specific_tags WHERE site = ? AND origin_name = ? AND meta_json = ?",
            (tags.SourceSite.Hitomi, hitomi_tag.origin_name, hitomi_tag.dump_specific_json()),
        ).fetchone()[0]
        assert "site" not in json.loads(stored_meta_json)

        # 可以从通用标签恢复全部来源标签，并保留每条来源标签的完整 meta。
        male_hitomi_tag = tags.SpecificTagHitomi(
            origin_name="test_origin",
            url="/character/test.html",
            tag_sex="male",
            group=tags.TagGroup.Tag,
        )
        manager.create_specific_tag(male_hitomi_tag, generic_tag)
        assert manager.get_linked_tags(generic_tag) == [
            hitomi_tag,
            male_hitomi_tag,
        ]

        empty_generic_tag = manager.create_generic_tag(
            "Empty Tag",
            tags.TagGroup.Tag,
        )
        assert manager.get_linked_tags(empty_generic_tag) == []

        missing_generic_tag = tags.GenericTag(
            name="Missing Tag",
            tag_group=tags.TagGroup.Tag,
        )
        try:
            manager.get_linked_tags(missing_generic_tag)
            assert False, "Expected NoGenericTagError"
        except tags.NoGenericTagError:
            pass

        # 仍被来源标签引用的通用标签不能删除。
        try:
            conn.execute(
                "DELETE FROM tags WHERE tag_group = ? AND name = ?",
                (generic_tag.tag_group, generic_tag.name),
            )
            assert False, "Expected an IntegrityError due to the foreign key restriction"
        except sqlite3.IntegrityError:
            pass
        assert manager._get_generic_tag_id(generic_tag) > 0

        try:
            manager.create_specific_tag(specific_tag, generic_tag) # type: ignore
            assert False, "Expected an IntegrityError due to unique constraint"
        except tags.MetaSchemaViolationError:
            print("Unique constraint enforced correctly for specific tags.")


test_tag_manager()
