import asyncio
import os
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Optional, Union, List, Iterable, Sequence, IO
import sqlmodel
from sqlalchemy import event
from sqlalchemy.exc import NoResultFound
from sqlalchemy.ext.asyncio import create_async_engine, AsyncEngine
from sqlalchemy.orm import aliased, selectinload
from sqlmodel.ext.asyncio.session import AsyncSession
# noinspection PyProtectedMember
from sqlmodel.sql._expression_select_cls import SelectOfScalar
import document_sql
import yaml

try:
    from site_utils import get_file_hash, archived_document_path, get_zip_namelist, get_zip_image, thumbnail_folder
except ImportError:
    print('非网站环境,哈希函数fallback至默认,document路径,thumbnail目录,zip相关函数置空')
    import hashlib


    async def get_file_hash(file_path: Union[str, Path], chunk_size: int = 8192):
        hash_md5 = hashlib.md5()
        with open(file_path, 'rb') as fi:
            while chunk := fi.read(chunk_size):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
    archived_document_path = Path(".")  # Fallback path
    thumbnail_folder = Path("thumbnails")


# ==========================================
# 核心数据库管理类 (异步版本)
# ==========================================

class DocumentDB:
    _engine: AsyncEngine | None = None
    _initialized: bool = False

    def __init__(self, db_file_name: str = "documents.db"):
        self.db_file_name = db_file_name
        self.session: AsyncSession | None = None

    @classmethod
    def _get_engine(cls, db_file_name: str) -> AsyncEngine:
        """获取或创建共享的异步引擎"""
        if cls._engine is None:
            sqlite_url = f"sqlite+aiosqlite:///{db_file_name}"
            cls._engine = create_async_engine(sqlite_url)
            # 通过事件监听器启用外键约束
            @event.listens_for(cls._engine.sync_engine, "connect")
            def set_sqlite_pragma(dbapi_conn, connection_record):
                cursor = dbapi_conn.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()
        return cls._engine

    async def __aenter__(self):
        engine = self._get_engine(self.db_file_name)
        # 首次使用时创建表结构
        if not DocumentDB._initialized:
            async with engine.begin() as conn:
                await conn.run_sync(sqlmodel.SQLModel.metadata.create_all)
            DocumentDB._initialized = True
        self.session = AsyncSession(engine)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()

    # 构建builder

    @staticmethod
    def query_all_documents() -> SelectOfScalar[document_sql.Document]:
        """返回查询所有文档的 Builder"""
        return sqlmodel.select(document_sql.Document).order_by(sqlmodel.desc(document_sql.Document.document_id))

    def query_by_tags(self, tags: List[int] | List[document_sql.Tag],
                      match_all: bool = True) -> SelectOfScalar[document_sql.Document]:
        tag_ids: set[int] = set()
        for tag_instance in tags:
            if isinstance(tag_instance, int):
                tag_ids.add(tag_instance)
            if isinstance(tag_instance, document_sql.Tag):
                tag_ids.add(tag_instance.tag_id)
        if not tag_ids:
            return self.query_all_documents()
        # 1. 基础 Join
        statement = (
            sqlmodel.select(document_sql.Document)
            .join(document_sql.DocumentTagLink)
            .where(sqlmodel.col(document_sql.DocumentTagLink.tag_id).in_(tag_ids))
        )
        # 2. 逻辑分支
        if match_all and len(tag_ids) > 1:
            # AND 逻辑：通过分组计数实现
            statement = (
                statement
                .group_by(document_sql.Document.document_id)
                .having(sqlmodel.func.count(document_sql.DocumentTagLink.tag_id) == len(tag_ids))
            )
        else:
            # OR 逻辑：去重即可
            statement = statement.distinct()
        return statement.order_by(sqlmodel.desc(document_sql.Document.document_id))

    def query_by_author(self, author_name: str) -> SelectOfScalar[document_sql.Document]:
        """返回按作者筛选的 Builder"""
        if not author_name:
            return self.query_all_documents()
        stmt = (
            sqlmodel.select(document_sql.Document)
            .join(document_sql.DocumentAuthorLink)
            .join(document_sql.Author)
            .where(document_sql.Author.name == author_name)
            .order_by(sqlmodel.desc(document_sql.Document.document_id))
        )
        return stmt

    # --- 新增: 通用分页执行器 ---

    async def paginate_query(self, statement: SelectOfScalar[document_sql.Document],
                       page: int,
                       page_size: int) -> tuple[int, Sequence[document_sql.Document]]:
        """
        接收一个 Builder，自动计算总数并返回当页数据
        """
        # 1. 计算总数 (Total Count)
        # 使用 select_from(statement.subquery()) 是最稳健的方法，能处理 distinct/join 等复杂情况
        count_stmt = sqlmodel.select(sqlmodel.func.count()).select_from(statement.subquery())
        total_count = (await self.session.exec(count_stmt)).one()
        # 2. 获取当页数据 (Pagination)
        offset_val = (page - 1) * page_size
        paginated_stmt = statement.offset(offset_val).limit(page_size)
        results = (await self.session.exec(paginated_stmt)).all()
        return total_count, results

    # --- 查询方法 ---

    async def get_all_document_ids(self) -> Sequence[document_sql.Document]:
        return (await self.session.exec(
            sqlmodel.select(document_sql.Document).order_by(sqlmodel.desc(document_sql.Document.document_id)))).all()

    async def search_by_tags(self, tags: Union[List[int], List[document_sql.Tag]],
                       match_all: bool = True) -> Sequence[document_sql.Document]:
        builder = self.query_by_tags(tags, match_all)
        return (await self.session.exec(builder)).all()

    async def search_by_name(self, name: str, exact_match: bool = False) -> Sequence[document_sql.Document]:
        statement = sqlmodel.select(document_sql.Document)
        if exact_match:
            statement = statement.where(document_sql.Document.title == name)
        else:
            statement = statement.where(sqlmodel.col(document_sql.Document.title).contains(name))
        return (await self.session.exec(statement)).all()

    async def search_by_author(self, author_name: str) -> Sequence[document_sql.Document]:
        builder = self.query_by_author(author_name)
        return (await self.session.exec(builder)).all()

    async def search_by_source(self, source_document_id: str,
                         source_id: Optional[int] = None,
                         allow_multi=False) -> document_sql.Document | list[document_sql.Document] | None:
        statement = sqlmodel.select(document_sql.DocumentSourceLink).where(
            document_sql.DocumentSourceLink.source_document_id == source_document_id
        )
        if source_id:
            statement = statement.where(document_sql.DocumentSourceLink.source_id == source_id)
        search_result = (await self.session.exec(statement)).all()
        if len(search_result) > 1:
            if allow_multi:
                return [await self.get_document_by_id(sr.document_id) for sr in search_result]
            raise ReferenceError('source_document_id 关联了多个文档, 指定source_id以缩小范围')
        if not search_result:
            return None
        return await self.get_document_by_id(search_result[0].document_id)

    async def search_by_file(self, filename: Union[str, Path]) -> Optional[document_sql.Document]:
        fname = filename.name if isinstance(filename, Path) else filename
        statement = sqlmodel.select(document_sql.Document).where(document_sql.Document.file_path == fname)
        return (await self.session.exec(statement)).first()

    async def get_document_by_id(self, doc_id: int) -> Optional[document_sql.Document]:
        # 使用 selectinload 预加载关联关系，避免异步懒加载问题
        statement = (
            sqlmodel.select(document_sql.Document)
            .where(document_sql.Document.document_id == doc_id)
            .options(
                selectinload(document_sql.Document.authors),
                selectinload(document_sql.Document.tags),
                selectinload(document_sql.Document.sources)
            )
        )
        return (await self.session.exec(statement)).first()

    async def get_range_documents(self, count=10, target_page: Optional[int] = None):
        statement = sqlmodel.select(document_sql.Document).order_by(
            sqlmodel.desc(document_sql.Document.document_id)).limit(count)
        if target_page is not None and target_page >= 1:
            offset_val = count * (target_page - 1)
            statement = statement.offset(offset_val)
        return (await self.session.exec(statement)).all()

    # --- 标签与元数据管理 ---

    async def get_tag_groups(self) -> Sequence[document_sql.TagGroup]:
        groups = (await self.session.exec(sqlmodel.select(document_sql.TagGroup))).all()
        return groups

    async def get_tag_by_name(self, name: str) -> Optional[document_sql.Tag]:
        return (await self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.name == name))).first()

    async def get_tags_by_group(self, group_id: int) -> Sequence[document_sql.Tag]:
        tags = (await self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.group_id == group_id))).all()
        return tags

    async def get_tag_by_hitomi(self, hitomi_name: str) -> Optional[document_sql.Tag]:
        try:
            return (await self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.hitomi_alter == hitomi_name))).one()
        except NoResultFound:
            return None

    async def get_tag(self, tag_id: int) -> document_sql.Tag | None:
        try:
            return (await self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.tag_id == tag_id))).one()
        except NoResultFound:
            return None

    # --- 写入与修改方法 ---

    async def add_source(self, name: str, base_url: Optional[str] = None) -> Optional[int]:
        try:
            source = document_sql.Source(name=name, base_url=base_url)
            self.session.add(source)
            await self.session.commit()
            await self.session.refresh(source)
            return source.source_id
        except Exception as ie:
            print(ie)
            await self.session.rollback()
            return None

    async def add_tag(self, tag: document_sql.Tag) -> Optional[document_sql.Tag]:
        try:
            self.session.add(tag)
            await self.session.commit()
            await self.session.refresh(tag)
            return tag
        except Exception as ie:
            print(ie)
            await self.session.rollback()
            return None

    async def add_document(self, title: str, filepath: Union[str, Path],
                     authors: Optional[Iterable[str]] = None,
                     series: Optional[str] = None,
                     volume: Optional[int] = None,
                     source: Optional[dict] = None,  # {'source_id': int, 'source_document_id': str}
                     given_id: int = None,
                     check_file=True) -> int:

        # 验证
        if series and not volume:
            raise ValueError('添加系列后必须添加卷')
        if volume and not str(volume).isdigit():
            raise ValueError('卷号必须为数字')

        filepath_str = os.path.basename(filepath)
        if check_file and not os.path.exists(filepath):
            raise FileNotFoundError(f'{filepath} 未找到')

        doc = document_sql.Document(
            document_id=given_id,
            title=title,
            file_path=filepath_str,
            series_name=series,
            volume_number=volume
        )
        self.session.add(doc)
        await self.session.commit()
        await self.session.refresh(doc)  # 获取生成的 ID

        # 处理作者
        if authors:
            for author_name in authors:
                # 查找或创建作者
                auth = (await self.session.exec(
                    sqlmodel.select(document_sql.Author).where(document_sql.Author.name == author_name))).first()
                if not auth:
                    auth = document_sql.Author(name=author_name)
                    self.session.add(auth)
                    await self.session.commit()
                    await self.session.refresh(auth)

                # 建立关联
                link = document_sql.DocumentAuthorLink(document_id=doc.document_id, author_id=auth.author_id)
                self.session.add(link)

        # 处理来源
        if source:
            await self.link_document_source(doc.document_id, source['source_id'], source['source_document_id'])

        await self.session.commit()
        return doc.document_id

    async def edit_document(self, doc_id: int,
                      title: Optional[str] = None,
                      filepath: Optional[Union[str, Path]] = None,
                      authors: Optional[List[str]] = None,
                      series: Optional[str] = None,
                      volume: Optional[int] = None,
                      verify_file: bool = True) -> int:

        doc = await self.session.get(document_sql.Document, doc_id)
        if not doc:
            return -1

        if title is not None:
            doc.title = title
        if series is not None:
            doc.series_name = series
        if volume is not None:
            doc.volume_number = volume
        if filepath is not None:
            if verify_file and not os.path.exists(filepath):
                return -1
            doc.file_path = os.path.basename(filepath)

        # 更新作者 (全量替换逻辑)
        if authors is not None:
            # 清除旧关联
            existing_links = (await self.session.exec(
                sqlmodel.select(document_sql.DocumentAuthorLink).where(
                    document_sql.DocumentAuthorLink.document_id == doc_id)
            )).all()
            for link in existing_links:
                await self.session.delete(link)

            # 添加新关联
            for author_name in authors:
                auth = (await self.session.exec(
                    sqlmodel.select(document_sql.Author).where(document_sql.Author.name == author_name))).first()
                if not auth:
                    auth = document_sql.Author(name=author_name)
                    self.session.add(auth)
                    await self.session.commit()
                    await self.session.refresh(auth)

                new_link = document_sql.DocumentAuthorLink(document_id=doc_id, author_id=auth.author_id)
                self.session.add(new_link)

        try:
            self.session.add(doc)
            await self.session.commit()
            return 0
        except Exception as e:
            await self.session.rollback()
            print(e)
            return -5

    async def delete_document(self, doc_id: int) -> int:
        doc = await self.session.get(document_sql.Document, doc_id)
        if doc:
            await self.session.delete(doc)
            await self.session.commit()
            return 0
        return -1

    async def link_document_source(self, doc_id: int, source_id: int, source_document_id: str) -> bool:
        try:
            link = document_sql.DocumentSourceLink(document_id=doc_id, source_id=source_id,
                                                   source_document_id=source_document_id)
            self.session.add(link)
            await self.session.commit()
            return True
        except Exception as ie:
            print(ie)
            await self.session.rollback()
            return False

    async def link_document_tag(self, doc_id: int, tag: int | document_sql.Tag) -> bool:
        try:
            if isinstance(tag, int):
                tag_id = tag
            else:
                tag_id = tag.tag_id
            link = document_sql.DocumentTagLink(document_id=doc_id, tag_id=tag_id)
            await self.session.merge(link)
            await self.session.commit()
            return True
        except Exception as e:
            print(e)
            await self.session.rollback()
            return False

    async def get_statistics(self, top_n: int = 10, recent_n: int = 10) -> document_sql.SiteStatistics:
        """返回站点统计数据"""
        # 总数统计
        total_documents = (await self.session.exec(
            sqlmodel.select(sqlmodel.func.count()).select_from(document_sql.Document)
        )).one()
        total_authors = (await self.session.exec(
            sqlmodel.select(sqlmodel.func.count()).select_from(document_sql.Author)
        )).one()
        total_tags = (await self.session.exec(
            sqlmodel.select(sqlmodel.func.count()).select_from(document_sql.Tag)
        )).one()

        # 热门标签 Top N
        top_tags_stmt = (
            sqlmodel.select(
                document_sql.Tag.tag_id,
                document_sql.Tag.name,
                document_sql.TagGroup.group_name,
                sqlmodel.func.count(document_sql.DocumentTagLink.document_id).label('document_count')
            )
            .join(document_sql.DocumentTagLink, document_sql.Tag.tag_id == document_sql.DocumentTagLink.tag_id)
            .join(document_sql.TagGroup, document_sql.Tag.group_id == document_sql.TagGroup.tag_group_id, isouter=True)
            .group_by(document_sql.Tag.tag_id)
            .order_by(sqlmodel.desc('document_count'))
            .limit(top_n)
        )
        top_tags = [
            document_sql.TagStats(tag_id=row.tag_id, name=row.name,
                                  group_name=row.group_name or '', document_count=row.document_count)
            for row in (await self.session.exec(top_tags_stmt)).all()
        ]

        # 高产作者 Top N
        top_authors_stmt = (
            sqlmodel.select(
                document_sql.Author.author_id,
                document_sql.Author.name,
                sqlmodel.func.count(document_sql.DocumentAuthorLink.document_id).label('document_count')
            )
            .join(document_sql.DocumentAuthorLink, document_sql.Author.author_id == document_sql.DocumentAuthorLink.author_id)
            .group_by(document_sql.Author.author_id)
            .order_by(sqlmodel.desc('document_count'))
            .limit(top_n)
        )
        top_authors = [
            document_sql.AuthorStats(author_id=row.author_id, name=row.name, document_count=row.document_count)
            for row in (await self.session.exec(top_authors_stmt)).all()
        ]

        # 最近添加的文档
        recent_stmt = (
            sqlmodel.select(document_sql.Document)
            .order_by(sqlmodel.desc(document_sql.Document.document_id))
            .limit(recent_n)
        )
        recent_documents = list((await self.session.exec(recent_stmt)).all())

        return document_sql.SiteStatistics(
            total_documents=total_documents,
            total_authors=total_authors,
            total_tags=total_tags,
            top_tags=top_tags,
            top_authors=top_authors,
            recent_documents=recent_documents
        )

    async def get_co_occurrences(self, top_n: int = 20) -> document_sql.CoOccurrenceResult:
        """返回标签共现和作者-标签共现数据"""
        # 标签共现：document_tags 自连接
        dt1 = aliased(document_sql.DocumentTagLink)
        dt2 = aliased(document_sql.DocumentTagLink)
        t1 = aliased(document_sql.Tag)
        t2 = aliased(document_sql.Tag)

        tag_co_stmt = (
            sqlmodel.select(
                dt1.tag_id.label('tag_a_id'),
                t1.name.label('tag_a_name'),
                dt2.tag_id.label('tag_b_id'),
                t2.name.label('tag_b_name'),
                sqlmodel.func.count().label('co_count')
            )
            .where(dt1.document_id == dt2.document_id)
            .where(dt1.tag_id < dt2.tag_id)
            .join(t1, dt1.tag_id == t1.tag_id)
            .join(t2, dt2.tag_id == t2.tag_id)
            .group_by(dt1.tag_id, dt2.tag_id)
            .order_by(sqlmodel.desc('co_count'))
            .limit(top_n)
        )
        tag_co_occurrences = [
            document_sql.TagCoOccurrence(
                tag_a_id=row.tag_a_id, tag_a_name=row.tag_a_name,
                tag_b_id=row.tag_b_id, tag_b_name=row.tag_b_name,
                co_count=row.co_count
            )
            for row in (await self.session.exec(tag_co_stmt)).all()
        ]

        # 作者-标签共现
        author_tag_stmt = (
            sqlmodel.select(
                document_sql.Author.author_id,
                document_sql.Author.name.label('author_name'),
                document_sql.Tag.tag_id,
                document_sql.Tag.name.label('tag_name'),
                sqlmodel.func.count().label('co_count')
            )
            .select_from(document_sql.DocumentAuthorLink)
            .join(document_sql.DocumentTagLink,
                  document_sql.DocumentAuthorLink.document_id == document_sql.DocumentTagLink.document_id)
            .join(document_sql.Author,
                  document_sql.DocumentAuthorLink.author_id == document_sql.Author.author_id)
            .join(document_sql.Tag,
                  document_sql.DocumentTagLink.tag_id == document_sql.Tag.tag_id)
            .group_by(document_sql.Author.author_id, document_sql.Tag.tag_id)
            .order_by(sqlmodel.desc('co_count'))
            .limit(top_n)
        )
        author_tag_co_occurrences = [
            document_sql.AuthorTagCoOccurrence(
                author_id=row.author_id, author_name=row.author_name,
                tag_id=row.tag_id, tag_name=row.tag_name,
                co_count=row.co_count
            )
            for row in (await self.session.exec(author_tag_stmt)).all()
        ]

        return document_sql.CoOccurrenceResult(
            tag_co_occurrences=tag_co_occurrences,
            author_tag_co_occurrences=author_tag_co_occurrences
        )

    async def get_wandering_files(self, base_path: Union[str, Path]) -> set[Path]:
        base_path = Path(base_path)
        if not base_path.exists():
            return set()
        local_files = {fi.name for fi in base_path.iterdir() if fi.is_file()}
        db_files = {file for file in (await self.session.exec(sqlmodel.select(document_sql.Document.file_path))).all()}
        return {base_path / Path(file) for file in local_files - db_files}


# ==========================================
# 独立的维护逻辑 (CLI Operations)
# ==========================================

async def fix_file_hash(idb: DocumentDB, base_path: Union[str, Path]):
    base_path = Path(base_path)
    test_files = [file for file in base_path.iterdir() if file.is_file()]

    for test_file in test_files:
        file_hash = await get_file_hash(test_file)
        name_hash = test_file.stem  # 假设文件名就是 hash.ext

        if file_hash == name_hash:
            continue

        print(f'文件 {test_file.name} 实际哈希 {file_hash} 不匹配')

        new_filename = f"{file_hash}{test_file.suffix}"
        new_file_path = base_path / new_filename

        if new_file_path.exists():
            print(f'哈希冲突：目标文件 {new_filename} 已存在，跳过')
            continue

        # 查找旧文件在数据库中的记录
        doc = await idb.search_by_file(test_file)
        if not doc:
            print(f'文件 {test_file.name} 未在数据库记录，跳过')
            continue

        shutil.move(test_file, new_file_path)
        print(f'Moved: {test_file.name} -> {new_filename}')

        res = await idb.edit_document(doc.document_id, filepath=new_file_path)
        if res == 0:
            print(f'数据库已更新为 {new_filename}')
        else:
            print(f'数据库更新失败 Code: {res}')


async def update_hitomi_file_hash(hitomi_id_list: list[int], idb: DocumentDB):
    try:
        import hitomiv2
    except ImportError:
        print('请先安装 hitomiv2 模块')
        hitomiv2 = None
        sys.exit(4)
    temp_document_content_path = Path('temp_document_content')
    await hitomiv2.refreshVersion()

    for ihid in hitomi_id_list:
        # 查找数据库中关联了该 source_id 的文档
        # 假设 hitomi 的 source_id 在数据库中是已知的，这里简化处理，只按 source_document_id 查
        doc = await idb.search_by_source(str(ihid))
        if not doc:
            print(f'Hitomi ID {ihid} 未在数据库中找到')
            continue

        print(f'Downloading {ihid}...')
        temp_file_path = temp_document_content_path / Path(f'{ihid}.zip')
        comic_file = open(temp_file_path, 'wb')
        try:
            document = await hitomiv2.getComic(ihid)
            dl_result = await hitomiv2.downloadComic(document, comic_file, max_threads=5)  # 假设返回文件路径字符串
            if not dl_result:
                raise RuntimeError("Download failed")

            file_hash = await get_file_hash(temp_file_path)
            new_name = f"{file_hash}.zip"
            target_path = archived_document_path / new_name

            # 检查此哈希是否已存在于其他文档
            exist_doc = await idb.search_by_file(new_name)
            if exist_doc:
                print(f'Hash {new_name} 已经存在于 ID {exist_doc}')
                raise FileExistsError
            comic_file.close()
            shutil.move(temp_file_path, target_path)
            await idb.edit_document(doc.document_id, filepath=target_path)
            print(f'Updated {ihid} -> {new_name}')

        except Exception as e:
            print(f'Error processing {ihid}: {e}')
        finally:
            if not comic_file.closed:
                comic_file.close()
            temp_file_path.unlink(missing_ok=True)


async def export_portable_document(document_id: int,
                                   db: DocumentDB,
                                   export_f: IO[bytes]):
    document = await db.get_document_by_id(document_id)
    if not document:
        raise FileNotFoundError(f'Document id {document_id} not found')
    # noinspection PyTypeChecker
    statement = (
        sqlmodel.select(document_sql.DocumentSourceLink, document_sql.Source)
        .join(document_sql.Source, document_sql.DocumentSourceLink.source_id == document_sql.Source.source_id)
        .where(document_sql.DocumentSourceLink.document_id == document_id)
    )
    link, source = (await db.session.exec(statement)).one()
    document_dict = {
        'document_metadata': document.model_dump(),
        'document_authors': [author.model_dump() for author in document.authors],
        'document_tags': [tag.model_dump() for tag in document.tags],
        'document_sources': [link.model_dump(), source.model_dump()],
    }
    document_path = archived_document_path / document.file_path
    if not document_path.exists():
        raise FileNotFoundError(f'document {document_path} not found')
    document_info_str = yaml.dump(document_dict, encoding='utf-8', allow_unicode=True)
    with open(document_path, 'rb') as df:
        while chunk := df.read(8192):
            export_f.write(chunk)
    with zipfile.ZipFile(export_f, 'a', zipfile.ZIP_DEFLATED) as zipf:
        zinfo = zipfile.ZipInfo(f'{document_id}.yaml', date_time=(1980, 1, 1, 0, 0, 0))
        zinfo.external_attr = 0o100644 << 16
        zinfo.compress_type = zipfile.ZIP_DEFLATED
        zipf.writestr(zinfo, document_info_str)


async def main_cli():
    """CLI 入口点"""
    if len(sys.argv) <= 1:
        exit(1)

    cmd_g = sys.argv[1]

    async with DocumentDB() as db_g:
        if cmd_g == 'clean':
            if not archived_document_path:
                print("Archived path not set")
                exit(1)
            wandering_files_g = await db_g.get_wandering_files(archived_document_path)
            print(f"Found {len(wandering_files_g)} unlinked files.")
            if input("Delete them? (y/n): ") == 'y':
                for f in wandering_files_g:
                    f.unlink()
                    print(f"Deleted {f.name}")
        elif cmd_g == 'fix_hash':
            if not archived_document_path:
                print("Archived path not set")
                exit(1)
            await fix_file_hash(db_g, archived_document_path)
        elif cmd_g == 'hitomi_update':
            try:
                hitomi_id_g = int(sys.argv[2])
                await update_hitomi_file_hash([hitomi_id_g], db_g)
            except (IndexError, ValueError):
                print("Invalid Hitomi ID")
        elif cmd_g == 'export':
            document_id_g = int(sys.argv[2])
            with open(f'{document_id_g}.zip', 'wb+') as ef:
                await export_portable_document(document_id_g, db_g, ef)
        elif cmd_g == 'test':
            # 简单的测试逻辑
            cnt_g = len(await db_g.get_all_document_ids())
            print(f"Database connected. Total documents: {cnt_g}")


if __name__ == '__main__':
    asyncio.run(main_cli())


async def get_db():
    async with DocumentDB() as db:
        yield db
