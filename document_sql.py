from typing import Optional, List
from sqlmodel import Field, SQLModel, Relationship, Index
from pydantic import BaseModel


# ==========================================
# 关联表 (Link Models / Association Tables)
# ==========================================

class DocumentAuthorLink(SQLModel, table=True):
    """
    documents 与 authors 的多对多关联表
    """
    __tablename__ = "document_authors" # type: ignore

    document_id: Optional[int] = Field(
        default=None,
        foreign_key="documents.document_id",
        primary_key=True,
        ondelete='CASCADE'
    )
    author_id: Optional[int] = Field(
        default=None,
        foreign_key="authors.author_id",
        ondelete='CASCADE',
        primary_key=True
    )


class DocumentTagLink(SQLModel, table=True):
    """
    documents 与 tags 的多对多关联表
    """
    __tablename__ = "document_tags" # type: ignore

    document_id: Optional[int] = Field(
        default=None,
        foreign_key="documents.document_id",
        ondelete='CASCADE',
        primary_key=True
    )
    tag_id: Optional[int] = Field(
        default=None,
        foreign_key="tags.tag_id",
        ondelete='CASCADE',
        primary_key=True
    )


class DocumentSourceLink(SQLModel, table=True):
    """
    documents 与 sources 的多对多关联表
    注意：此表包含 payload 字段 source_document_id，
    在 ORM 中通常作为关联对象处理，此处定义为带额外字段的 Link Model。
    """
    __tablename__ = "document_sources" # type: ignore

    document_id: int = Field(
        default=None,
        foreign_key="documents.document_id",
        ondelete='CASCADE',
        primary_key=True
    )
    source_id: int = Field(
        default=None,
        foreign_key="sources.source_id",
        ondelete='CASCADE',
        primary_key=True
    )
    # 对应 DDL 中的 source_document_id 及其唯一索引
    source_document_id: str = Field(unique=True, index=True)


# ==========================================
# 实体表 (Entity Models)
# ==========================================

class Author(SQLModel, table=True):
    __tablename__ = "authors" # type: ignore

    author_id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)

    # Relationship: Many-to-Many via DocumentAuthorLink
    documents: List["Document"] = Relationship(
        back_populates="authors", link_model=DocumentAuthorLink
    )


class Source(SQLModel, table=True):
    __tablename__ = "sources" # type: ignore

    source_id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    base_url: Optional[str] = None

    # Relationship: Many-to-Many via DocumentSourceLink
    # 注意：如果需要访问关联表中的 source_document_id，建议直接查询 Link Model 或使用高级 SQLAlchemy 关联代理
    documents: List["Document"] = Relationship(
        back_populates="sources", link_model=DocumentSourceLink
    )


class TagGroup(SQLModel, table=True):
    __tablename__ = "tag_groups" # type: ignore

    tag_group_id: Optional[int] = Field(default=None, primary_key=True)
    group_name: str = Field(unique=True)

    # Relationship: One-to-Many
    tags: List["Tag"] = Relationship(back_populates="group")


class Tag(SQLModel, table=True):
    __tablename__ = "tags" # type: ignore

    tag_id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    hitomi_alter: Optional[str] = None

    # Foreign Key
    group_id: Optional[int] = Field(default=None,
                                    foreign_key="tag_groups.tag_group_id",
                                    ondelete='CASCADE')

    # Relationship: Many-to-One
    group: Optional[TagGroup] = Relationship(back_populates="tags")

    # Relationship: Many-to-Many via DocumentTagLink
    documents: List["Document"] = Relationship(
        back_populates="tags", link_model=DocumentTagLink
    )


class Document(SQLModel, table=True):
    __tablename__ = "documents" # type: ignore

    # 定义复合索引：对应 CREATE INDEX ... ON documents (series_name, volume_number)
    __table_args__ = (
        Index("idx_documents_series", "series_name", "volume_number"),
    )

    document_id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(index=True)  # 对应 idx_documents_title
    file_path: str = Field(unique=True)
    series_name: Optional[str] = None
    volume_number: Optional[int] = None

    # Relationship: Many-to-Many
    authors: List[Author] = Relationship(
        back_populates="documents", link_model=DocumentAuthorLink
    )

    tags: List[Tag] = Relationship(
        back_populates="documents", link_model=DocumentTagLink
    )

    sources: List[Source] = Relationship(
        back_populates="documents", link_model=DocumentSourceLink
    )


class DocumentMetadata(BaseModel):
    document_info: Document
    document_authors: list[Author]
    document_tags: list[Tag]
    document_pages: list[str] | None = None

