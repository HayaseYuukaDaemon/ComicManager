import enum
from typing import Annotated, Literal, TypeAlias, Callable, Awaitable
import pydantic
import asyncio
import sqlite3


class SourceSite(str, enum.Enum):
    Hitomi = "hitomi.la"
    NHentai = "nhentai.net"
    JmComic = "18comic.vip"

class TagGroup(str, enum.Enum):
    Tag = "tag"
    Character = "character" 
    Parody = "parody" # 世界观
    Expo = "expo" # 展会
    Group = "group" # 所属发行社团
    Language = "language" # 语言

class SpecificTag(pydantic.BaseModel):
    """
    各站点标签元信息的公共基类。

    不直接用于反序列化；实际类型由 SpecificTagMetaUnion 决定。
    """

    model_config = pydantic.ConfigDict(
        extra="forbid",
        validate_assignment=True,
    )

    origin_name: str
    origin_group: str | None = None

# --- 站点tag元数据定义开始 ---

class SpecificTagHitomi(SpecificTag):
    site: Literal[SourceSite.Hitomi] = SourceSite.Hitomi

    url: str | None = None
    tag_sex: Literal["male", "female"] | None = None


class SpecificTagNHentai(SpecificTag):
    site: Literal[SourceSite.NHentai] = SourceSite.NHentai

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
    specific_metas: list[SpecificTagUnion]
    name: str


class TagExtractor:
    TagMapFunc = Callable[[SpecificTagUnion], GenericTag]
    tag_map_func: TagMapFunc

    def __init__(self,
                 sqlite_conn: sqlite3.Connection | None = None, 
                 tag_maps: dict[SourceSite, dict[str, GenericTag]] | None = None,
                 custom_tag_map_func: TagMapFunc | None = None
                 ) -> None:
        if sqlite_conn is not None:
            self.sqlite_conn = sqlite_conn
            self.tag_map_func = self._get_generic_tag_from_db
        elif tag_maps is not None:
            self.tag_maps = tag_maps
            self.tag_map_func = self._get_generic_tag_from_dict
        elif custom_tag_map_func is not None:
            self.tag_map_func = custom_tag_map_func
        else:
            self.tag_map_func = self._get_generic_tag_stub

    def _get_generic_tag_from_dict(self, meta: SpecificTagUnion) -> GenericTag:
        """
        从字典中获取通用标签。
        Args:
            meta: 站点特定的标签元信息。
        Returns:
            转换后的通用标签。
        """

        if meta.site not in self.tag_maps:
            raise ValueError(f"No tag mappings found for site {meta.site}")
        
        site_map = self.tag_maps[meta.site]

        if meta.origin_name not in site_map:
            raise ValueError(f"No tag mappings found for group {meta.origin_name} in site {meta.site}")

        return site_map[meta.origin_name]

    # 这个目前也是stub实现, 我还没开始设计数据库结构
    def _get_generic_tag_from_db(self, meta: SpecificTagUnion) -> GenericTag:
        """
        从数据库中获取通用标签。
        Args:
            meta: 站点特定的标签元信息。
        Returns:
            转换后的通用标签。
        """

        cursor = self.sqlite_conn.cursor()
        cursor.execute(
            "SELECT tag_group, name FROM tag_mappings WHERE origin_name = ? AND origin_group = ?",
            (meta.origin_name, meta.origin_group),
        )
        row = cursor.fetchone()
        if row is None:
            raise ValueError(f"No mapping found for {meta.origin_name} in group {meta.origin_group}")
        
        tag_group, name = row
        return GenericTag(
            tag_group=TagGroup(tag_group),
            specific_metas=[meta],
            name=name,
        )

    def _get_generic_tag_stub(self, meta: SpecificTagUnion) -> GenericTag:
        """
        将站点特定的标签元信息转换为通用标签
        !!! 这是直接映射 !!!
        Args:
            meta: 站点特定的标签元信息。
        Returns:
            转换后的通用标签。
        """

        return GenericTag(
            tag_group=TagGroup(meta.origin_group),
            specific_metas=[meta],
            name=meta.origin_name,
        )

    def extract_hitomi_tags(self, hitomi_metas: dict) -> list[GenericTag]:
        """
        从 Hitomi 文档中提取标签。
        Args:
            hitomi_metas: Hitomi 文档的元信息。
        Returns:
            提取的通用标签列表。
        """

        tag_metas: list[SpecificTagHitomi] = []

        # 提取parody标签
        if "parodys" in hitomi_metas and hitomi_metas["parodys"]:
            for parody in hitomi_metas["parodys"]:
                tag_metas.append(
                    SpecificTagHitomi(
                        origin_name=parody['parody'],
                        origin_group='parody',
                        url=parody.get('url', None),
                    )
                )
        
        # 提取character标签
        if "characters" in hitomi_metas and hitomi_metas["characters"]:
            for character in hitomi_metas["characters"]:
                tag_metas.append(
                    SpecificTagHitomi(
                        origin_name=character['character'],
                        origin_group='character',
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
                        origin_name=tag['tag'],
                        origin_group='tag',
                        tag_sex=tag_sex,
                        url=tag.get('url', None),
                    )
                )

        return [self.tag_map_func(meta) for meta in tag_metas]