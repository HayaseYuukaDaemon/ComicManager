import enum
from typing import Annotated, Literal, TypeAlias
from abc import ABC, abstractmethod
import pydantic
import hashlib
import json
import sqlite3


class SourceSite(str, enum.Enum):
    Hitomi = "hitomi"
    NHentai = "nhentai"
    JmComic = "jmcomic"

class TagGroup(str, enum.Enum):
    Tag = "tag"
    Character = "character" 
    Parody = "parody" # 世界观
    Expo = "expo" # 展会
    Group = "group" # 所属发行社团
    Language = "language" # 语言


# TODO(schema-hash):
# 当前 meta_schema_hash 只根据站点特有字段的名称集合计算哈希，
# 目的是以最低复杂度检测字段的新增、删除和重命名。
#
# 当前算法有意忽略以下 schema 变化：
# - 字段类型变化，例如 str | None -> int | None；
# - required / optional 和默认值变化；
# - Literal 枚举、数值范围、字符串格式等声明式约束变化；
# - Pydantic validator 的实现变化。
#
# 如果以后需要检测字段类型和声明式约束，应将算法升级为基于
# Pydantic JSON Schema 的哈希，建议流程如下：
#
# 1. 取得具体子类相对于 SpecificTagMeta 新增的字段；
# 2. 使用 Pydantic TypeAdapter 或 model_json_schema() 为这些字段
#    生成 validation 模式的 JSON Schema；
# 3. 删除 title、description、examples 等不影响数据兼容性的展示字段；
# 4. 对剩余 schema 执行 canonical JSON 序列化：
#       json.dumps(
#           schema,
#           sort_keys=True,
#           separators=(",", ":"),
#           ensure_ascii=False,
#           allow_nan=False,
#       )
# 5. 对序列化结果计算 SHA-256；
# 6. 将哈希格式版本改为：
#       jsonschema-v1:sha256:<digest>
#
# 哈希值必须携带算法版本，不能直接用新算法覆盖旧值。
# 数据库中的 keys-v1 和 jsonschema-v1 表示不同的比较语义，
# 升级时应通过迁移逻辑重新计算，而不能直接判定旧数据损坏。
#
# JSON Schema 仍然通常无法反映任意 Python validator 的实现变化。
# 如果 validator 或迁移语义的变化也需要被感知，应额外为每个站点
# 模型维护一个显式 META_SCHEMA_REVISION，并将其纳入哈希描述。
class SpecificTag(pydantic.BaseModel, ABC):
    """
    各站点标签元信息的公共基类。

    不直接用于反序列化；实际类型由 SpecificTagMetaUnion 决定。
    """

    model_config = pydantic.ConfigDict(
        extra="forbid",
        validate_assignment=True,
    )

    origin_name: str

    @abstractmethod
    def generalize(self, manager: "TagManager") -> "GenericTag":
        """
        将站点特定的标签元信息转换为通用标签。
        Args:
            manager: TagManager 实例
        Returns:
            转换后的通用标签。
        Raises:
            NoGenericTagError: 如果站点特定标签没有对应的通用标签。
        """
        ...

    @classmethod
    def specific_field_names(cls) -> tuple[str, ...]:
        """
        返回当前具体类型相对于 SpecificTagMeta 新增的字段名。
        字段名经过排序，因此不受字段声明顺序影响。
        """
        # site 是判别联合要求的字段，只能由具体子类声明为 Literal；
        # 它和 origin_name 一样独立存储，不属于 meta_json。
        base_fields = SpecificTag.model_fields.keys() | {"site"}
        concrete_fields = cls.model_fields.keys()
        return tuple(sorted(concrete_fields - base_fields))

    @classmethod
    def meta_schema_hash(cls) -> str:
        """
        根据站点特有字段名集合计算稳定的 schema 哈希。

        该哈希只检测字段的新增、删除和重命名，不检测：
        - 字段类型变化；
        - 默认值变化；
        - required / optional 变化；
        - Literal、范围等约束变化；
        - validator 实现变化。
        """
        canonical_schema = json.dumps(
            cls.specific_field_names(),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        digest = hashlib.sha256(canonical_schema).hexdigest()
        # 带上算法版本，便于以后升级为 JSON Schema 哈希。
        return f"keys-v1:sha256:{digest}"

    def dump_specific_fields(self) -> dict[str, object]:
        return self.model_dump(
            mode="json",
            include=set(type(self).specific_field_names()),
            exclude_none=True,
        )

    def dump_specific_json(self) -> str:
        return json.dumps(
            self.dump_specific_fields(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )


# --- 站点tag元数据定义开始 ---

class SpecificTagHitomi(SpecificTag):
    site: Literal[SourceSite.Hitomi] = SourceSite.Hitomi

    group: TagGroup
    url: str | None = None
    tag_sex: Literal["male", "female"] | None = None

    def generalize(self, manager: "TagManager") -> "GenericTag":
        cursor = manager.sqlite_conn.cursor()
        result = cursor.execute(
            "SELECT generic_tag_id FROM specific_tags WHERE site = ? AND origin_name = ? AND meta_json = ?",
            (self.site, self.origin_name, self.dump_specific_json())
        ).fetchone()
        result = cursor.execute(
            "SELECT name, tag_group FROM tags WHERE id = ?",
            (result[0],)
        ).fetchone()
        if result:
            return GenericTag(tag_group=result[1], name=result[0])
        else:
            raise NoGenericTagError(GenericTag(tag_group=self.group, name=self.origin_name))


class SpecificTagNHentai(SpecificTag):
    site: Literal[SourceSite.NHentai] = SourceSite.NHentai

    group: TagGroup

class SpecificTagJmComic(SpecificTag):
    site: Literal[SourceSite.JmComic] = SourceSite.JmComic


SpecificTagUnion: TypeAlias = Annotated[
    SpecificTagHitomi | SpecificTagNHentai | SpecificTagJmComic,
    pydantic.Field(discriminator="site"),
]

# --- 站点tag元数据定义结束 ---

class GenericTag(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(
        extra="forbid",
        validate_assignment=True,
    )

    tag_group: TagGroup | str
    name: str


class NoGenericTagError(Exception):
    """当站点特定标签没有对应的通用标签时抛出此异常。"""
    def __init__(self, tag: GenericTag) -> None:
        self.generic_tag = tag
        message = f"No generic tag found for specific tag: {tag}"
        super().__init__(message)


class MetaSchemaViolationError(Exception):
    """当站点特定标签的元信息不符合预期的 schema 时抛出此异常。"""
    def __init__(self, specific_tag: SpecificTagUnion, db_schema_hash: str, tag_schema_hash: str) -> None:
        self.specific_tag = specific_tag
        super().__init__(f"Meta schema violation for {specific_tag}, expected schema hash: {tag_schema_hash}, but found: {db_schema_hash}")


class GenericTagExistsError(Exception):
    """当尝试创建已存在的通用标签时抛出此异常。"""
    def __init__(self, generic_tag: GenericTag) -> None:
        message = f"Generic tag already exists: {generic_tag.name} in group {generic_tag.tag_group}"
        super().__init__(message)


class SpecificTagExistsError(Exception):
    """当尝试创建已存在的站点特定标签时抛出此异常。"""
    def __init__(self, specific_tag: SpecificTagUnion) -> None:
        message = f"Specific tag already exists: {specific_tag.origin_name} for site {specific_tag.site}"
        super().__init__(message)


def extract_hitomi_tags(hitomi_metas: dict) -> list[SpecificTagHitomi]:
    """
    从 Hitomi 文档中提取标签。
    Args:
        hitomi_metas: Hitomi 文档的元信息。
    Returns:
        提取的Hitomi标签列表。
    """

    tag_metas: list[SpecificTagHitomi] = []

    # 提取parody标签
    if "parodys" in hitomi_metas and hitomi_metas["parodys"]:
        for parody in hitomi_metas["parodys"]:
            tag_metas.append(
                SpecificTagHitomi(
                    group=TagGroup.Parody,
                    origin_name=parody['parody'],
                    url=parody.get('url', None),
                )
            )
    
    # 提取character标签
    if "characters" in hitomi_metas and hitomi_metas["characters"]:
        for character in hitomi_metas["characters"]:
            tag_metas.append(
                SpecificTagHitomi(
                    group=TagGroup.Character,
                    origin_name=character['character'],
                    url=character.get('url', None),
                )
            )

    # 提取tag标签
    if "tags" in hitomi_metas and hitomi_metas["tags"]:
        for tag in hitomi_metas["tags"]:
            tag_sex = None
            if tag.get('male', False):
                tag_sex = 'male'
            elif tag.get('female', False):
                tag_sex = 'female'
            tag_metas.append(
                SpecificTagHitomi(
                    group=TagGroup.Tag,
                    origin_name=tag['tag'],
                    tag_sex=tag_sex,
                    url=tag.get('url', None),
                )
            )

    return tag_metas

class TagManager:
    def __init__(self, sqlite_conn: sqlite3.Connection) -> None:
        self.sqlite_conn = sqlite_conn

    def create_generic_tag(self, name: str, group: TagGroup | str) -> GenericTag:
        """
        将站点特定的标签元信息转换为通用标签。
        Args:
            name: 标签名称。
            group: 标签组。
        Returns:
            转换后的通用标签。
        Raises:
            GenericTagExistsError: 如果通用标签已存在。
        """
        cursor = self.sqlite_conn.cursor()
        try:
            cursor.execute(
                "INSERT INTO tags (tag_group, name) VALUES (?, ?)",
                (group, name)
            )
            self.sqlite_conn.commit()
            return GenericTag(tag_group=group, name=name)
        except sqlite3.IntegrityError as e:
            raise GenericTagExistsError(GenericTag(tag_group=group, name=name)) from e

    def get_linked_tags(self, generic_tag: GenericTag) -> list[SpecificTagUnion]:
        """
        获取与通用标签关联的所有站点特定标签。
        Args:
            generic_tag: 通用标签。
        Returns:
            与通用标签关联的站点特定标签列表。
        Raises:
            NoGenericTagError: 如果通用标签不存在。
        """
        generic_tag_id = self._get_generic_tag_id(generic_tag)
        rows = self.sqlite_conn.execute(
            """
            SELECT site, origin_name, meta_json
            FROM specific_tags
            WHERE generic_tag_id = ?
            ORDER BY id
            """,
            (generic_tag_id,),
        ).fetchall()

        adapter = pydantic.TypeAdapter(SpecificTagUnion)
        linked_tags: list[SpecificTagUnion] = []
        for site, origin_name, meta_json in rows:
            specific_fields = json.loads(meta_json)
            # site 和 origin_name 的数据库列是权威数据源；meta_json 只补充
            # 具体站点模型的特有字段。
            specific_fields["site"] = site
            specific_fields["origin_name"] = origin_name
            linked_tags.append(adapter.validate_python(specific_fields))

        return linked_tags

    def _create_meta_schema(self, specific_tag: SpecificTagUnion) -> None:
        """
        创建站点特定标签的元信息 schema。
        Args:
            specific_tag: 站点特定标签。
        Raises:
            MetaSchemaViolationError: 如果站点特定标签的元信息不符合预期的 schema。
        """
        schema_hash = specific_tag.meta_schema_hash()
        cursor = self.sqlite_conn.cursor()
        cursor.execute(
            "SELECT schema_hash FROM meta_schema_version WHERE site = ?",
            (specific_tag.site,)
        )
        row = cursor.fetchone()
        if row is None:
            # 如果数据库中没有该站点的 schema_hash，插入新的记录
            cursor.execute(
                "INSERT INTO meta_schema_version (site, schema_hash) VALUES (?, ?)",
                (specific_tag.site, schema_hash)
            )
            self.sqlite_conn.commit()
        else:
            raise ValueError(f"Meta schema for site {specific_tag.site} already exists with hash {row[0]}")

    def _get_generic_tag_id(self, generic_tag: GenericTag) -> int:
        """
        获取通用标签的 ID。
        Args:
            generic_tag: 通用标签。
        Returns:
            通用标签的 ID。
        Raises:
            NoGenericTagError: 如果通用标签不存在。
        """
        cursor = self.sqlite_conn.cursor()
        cursor.execute(
            "SELECT id FROM tags WHERE tag_group = ? AND name = ?",
            (generic_tag.tag_group, generic_tag.name)
        )
        row = cursor.fetchone()
        if row is None:
            raise NoGenericTagError(generic_tag)
        return row[0]

    def create_specific_tag(self, specific_tag: SpecificTagUnion, generic_tag: GenericTag) -> None:
        """
        创建站点特定标签并与通用标签关联。
        Args:
            specific_tag: 站点特定标签。
            generic_tag: 通用标签。
        Raises:
            NoGenericTagError: 如果通用标签不存在。
            MetaSchemaViolationError: 如果站点特定标签的元信息不符合预期的 schema。
            SpecificTagExistsError: 如果站点特定标签已存在。
        """
        schema_hash = specific_tag.meta_schema_hash()
        cursor = self.sqlite_conn.cursor()
        cursor.execute(
            "SELECT schema_hash FROM meta_schema_version WHERE site = ?",
            (specific_tag.site,)
        )
        row = cursor.fetchone()
        if row is None:
            self._create_meta_schema(specific_tag)
        cursor.execute(
            "SELECT schema_hash FROM meta_schema_version WHERE site = ?",
            (specific_tag.site,)
        )
        row = cursor.fetchone()
        db_schema_hash = row[0]
        if db_schema_hash != schema_hash:
            raise MetaSchemaViolationError(specific_tag, db_schema_hash, schema_hash)
        generic_tag_id = self._get_generic_tag_id(generic_tag)
        try:
            cursor.execute(
                "INSERT INTO specific_tags (site, origin_name, meta_json, generic_tag_id) VALUES (?, ?, ?, ?)",
                (specific_tag.site, specific_tag.origin_name, specific_tag.dump_specific_json(), generic_tag_id)
            )
            self.sqlite_conn.commit()
        except sqlite3.IntegrityError as e:
            print(e)
            raise SpecificTagExistsError(specific_tag) from e
