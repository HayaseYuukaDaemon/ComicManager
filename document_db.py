import asyncio
import os
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Optional, Union, List, Iterable, Sequence, IO, overload, Literal
import sqlmodel
from sqlalchemy.exc import NoResultFound
# noinspection PyProtectedMember
from sqlmodel.sql._expression_select_cls import SelectOfScalar
import document_sql
import yaml
from site_utils import get_file_hash, archived_document_path


# ==========================================
# 核心数据库管理类
# ==========================================

class DocumentDB:
    def __init__(self, db_file_name: str = "documents.db"):
        sqlite_url = f"sqlite:///{db_file_name}"
        self.engine = sqlmodel.create_engine(sqlite_url)
        # 自动创建表结构（如果是新库）
        sqlmodel.SQLModel.metadata.create_all(self.engine)
        self.session = sqlmodel.Session(self.engine)
        # 启用外键约束
        self.session.connection().execute(sqlmodel.text("PRAGMA foreign_keys=ON"))

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.session.close()

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
                if tag_instance.tag_id is not None:
                    tag_ids.add(tag_instance.tag_id)
                else:
                    raise ValueError(f"Tag instance {tag_instance} has no tag_id")
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
                .group_by(sqlmodel.col(document_sql.Document.document_id))
                .having(sqlmodel.func.count(sqlmodel.col(document_sql.DocumentTagLink.tag_id)) == len(tag_ids))
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

    def paginate_query(self, statement: SelectOfScalar[document_sql.Document],
                       page: int,
                       page_size: int) -> tuple[int, Sequence[document_sql.Document]]:
        """
        接收一个 Builder，自动计算总数并返回当页数据
        """
        # 1. 计算总数 (Total Count)
        # 使用 select_from(statement.subquery()) 是最稳健的方法，能处理 distinct/join 等复杂情况
        count_stmt = sqlmodel.select(sqlmodel.func.count()).select_from(statement.subquery())
        total_count = self.session.exec(count_stmt).one()
        # 2. 获取当页数据 (Pagination)
        offset_val = (page - 1) * page_size
        paginated_stmt = statement.offset(offset_val).limit(page_size)
        results = self.session.exec(paginated_stmt).all()
        return total_count, results

    # --- 查询方法 ---

    def get_document_source_document_id(self, document_ptr: int | document_sql.Document) -> str:
        document_id = document_ptr if isinstance(document_ptr, int) else document_ptr.document_id
        statement = (
            sqlmodel.select(document_sql.DocumentSourceLink.source_document_id)
            .select_from(document_sql.Source)
            .join(document_sql.DocumentSourceLink, sqlmodel.col(document_sql.DocumentSourceLink.source_id) == document_sql.Source.source_id)
            .where(document_sql.DocumentSourceLink.document_id == document_id)
        )
    
        # session.exec 会返回包含 (Source, str) 的 Tuple
        results = self.session.exec(statement).one()

        return results

    def get_all_document_ids(self) -> Sequence[document_sql.Document]:
        return self.session.exec(
            sqlmodel.select(document_sql.Document).order_by(sqlmodel.desc(document_sql.Document.document_id))).all()

    def search_by_tags(self, tags: Union[List[int], List[document_sql.Tag]],
                       match_all: bool = True) -> Sequence[document_sql.Document]:
        builder = self.query_by_tags(tags, match_all)
        return self.session.exec(builder).all()

    def search_by_name(self, name: str, exact_match: bool = False) -> Sequence[document_sql.Document]:
        statement = sqlmodel.select(document_sql.Document)
        if exact_match:
            statement = statement.where(document_sql.Document.title == name)
        else:
            statement = statement.where(sqlmodel.col(document_sql.Document.title).contains(name))
        return self.session.exec(statement).all()

    def search_by_author(self, author_name: str) -> Sequence[document_sql.Document]:
        builder = self.query_by_author(author_name)
        return self.session.exec(builder).all()

    @overload
    def search_by_source(
        self, 
        source_document_id: str,
        source_id: int | None = None,
        *,
        allow_multi: Literal[False] = False
    ) -> document_sql.Document | None: ...
    
    @overload
    def search_by_source(
        self,
        source_document_id: str,
        source_id: int | None = None,
        *,
        allow_multi: Literal[True]
    ) -> list[document_sql.Document] | None: ...

    def search_by_source(
        self,
        source_document_id: str,
        source_id: int | None = None,
        *,
        allow_multi: bool = False,
    ) -> document_sql.Document | list[document_sql.Document] | None:
        statement = sqlmodel.select(document_sql.DocumentSourceLink).where(
            document_sql.DocumentSourceLink.source_document_id == source_document_id
        )
        if source_id:
            statement = statement.where(document_sql.DocumentSourceLink.source_id == source_id)
        search_result: Sequence[document_sql.DocumentSourceLink] = self.session.exec(statement).all()
        if len(search_result) > 1:
            if allow_multi:
                documents = []
                for sr in search_result:
                    doc = self.get_document_by_id(sr.document_id)
                    if doc:
                        documents.append(doc)
                return documents
            raise ReferenceError('source_document_id 关联了多个文档, 指定source_id以缩小范围')
        if not search_result:
            return None
        return self.get_document_by_id(search_result[0].document_id)

    def search_by_file(self, filename: Union[str, Path]) -> Optional[document_sql.Document]:
        fname = filename.name if isinstance(filename, Path) else filename
        statement = sqlmodel.select(document_sql.Document).where(document_sql.Document.file_path == fname)
        return self.session.exec(statement).first()

    def get_document_by_id(self, doc_id: int) -> Optional[document_sql.Document]:
        return self.session.get(document_sql.Document, doc_id)

    def get_range_documents(self, count=10, target_page: Optional[int] = None):
        statement = sqlmodel.select(document_sql.Document).order_by(
            sqlmodel.desc(document_sql.Document.document_id)).limit(count)
        if target_page is not None and target_page >= 1:
            offset_val = count * (target_page - 1)
            statement = statement.offset(offset_val)
        return self.session.exec(statement).all()

    # --- 标签与元数据管理 ---

    def get_tag_groups(self) -> Sequence[document_sql.TagGroup]:
        groups = self.session.exec(sqlmodel.select(document_sql.TagGroup)).all()
        return groups

    def get_tag_by_name(self, name: str) -> Optional[document_sql.Tag]:
        return self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.name == name)).first()

    def get_tags_by_group(self, group_id: int) -> Sequence[document_sql.Tag]:
        tags = self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.group_id == group_id)).all()
        return tags

    def get_tag_by_hitomi(self, hitomi_name: str) -> Optional[document_sql.Tag]:
        try:
            return self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.hitomi_alter == hitomi_name)).one()
        except NoResultFound:
            return None

    def get_tag(self, tag_id: int) -> document_sql.Tag | None:
        try:
            return self.session.exec(sqlmodel.select(document_sql.Tag).where(document_sql.Tag.tag_id == tag_id)).one()
        except NoResultFound:
            return None

    # --- 写入与修改方法 ---

    def add_source(self, name: str, base_url: Optional[str] = None) -> Optional[int]:
        try:
            source = document_sql.Source(name=name, base_url=base_url)
            self.session.add(source)
            self.session.commit()
            self.session.refresh(source)
            return source.source_id
        except Exception as ie:
            print(ie)
            self.session.rollback()
            return None

    def add_tag(self, tag: document_sql.Tag) -> Optional[document_sql.Tag]:
        try:
            self.session.add(tag)
            self.session.commit()
            self.session.refresh(tag)
            return tag
        except Exception as ie:
            print(ie)
            self.session.rollback()
            return None

    def add_document(self, title: str, filepath: Union[str, Path],
                     authors: Optional[Iterable[str]] = None,
                     series: Optional[str] = None,
                     volume: Optional[int] = None,
                     source: Optional[dict] = None,  # {'source_id': int, 'source_document_id': str}
                     given_id: int | None = None,
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
        self.session.commit()
        self.session.refresh(doc)  # 获取生成的 ID
        assert doc.document_id is not None, "Document ID should not be None after refresh"
        # 处理作者
        if authors:
            for author_name in authors:
                # 查找或创建作者
                auth = self.session.exec(
                    sqlmodel.select(document_sql.Author).where(document_sql.Author.name == author_name)).first()
                if not auth:
                    auth = document_sql.Author(name=author_name)
                    self.session.add(auth)
                    self.session.commit()
                    self.session.refresh(auth)

                # 建立关联
                link = document_sql.DocumentAuthorLink(document_id=doc.document_id, author_id=auth.author_id)
                self.session.add(link)

        # 处理来源
        if source:
            self.link_document_source(doc.document_id, source['source_id'], source['source_document_id'])

        self.session.commit()
        return doc.document_id

    def edit_document(self, doc_id: int,
                      title: Optional[str] = None,
                      filepath: Optional[Union[str, Path]] = None,
                      authors: Optional[List[str]] = None,
                      series: Optional[str] = None,
                      volume: Optional[int] = None,
                      verify_file: bool = True) -> int:

        doc = self.session.get(document_sql.Document, doc_id)
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
            existing_links = self.session.exec(
                sqlmodel.select(document_sql.DocumentAuthorLink).where(
                    document_sql.DocumentAuthorLink.document_id == doc_id)
            ).all()
            for link in existing_links:
                self.session.delete(link)

            # 添加新关联
            for author_name in authors:
                auth = self.session.exec(
                    sqlmodel.select(document_sql.Author).where(document_sql.Author.name == author_name)).first()
                if not auth:
                    auth = document_sql.Author(name=author_name)
                    self.session.add(auth)
                    self.session.commit()
                    self.session.refresh(auth)

                new_link = document_sql.DocumentAuthorLink(document_id=doc_id, author_id=auth.author_id)
                self.session.add(new_link)

        try:
            self.session.add(doc)
            self.session.commit()
            return 0
        except Exception as e:
            self.session.rollback()
            print(e)
            return -5

    def delete_document(self, doc_id: int) -> int:
        doc = self.session.get(document_sql.Document, doc_id)
        if doc:
            self.session.delete(doc)
            self.session.commit()
            return 0
        return -1

    def link_document_source(self, doc_id: int, source_id: int, source_document_id: str) -> bool:
        try:
            link = document_sql.DocumentSourceLink(document_id=doc_id, source_id=source_id,
                                                   source_document_id=source_document_id)
            self.session.add(link)
            self.session.commit()
            return True
        except Exception as ie:
            print(ie)
            self.session.rollback()
            return False

    def link_document_tag(self, doc_id: int, tag: int | document_sql.Tag) -> bool:
        try:
            if isinstance(tag, int):
                tag_id = tag
            else:
                tag_id = tag.tag_id
            link = document_sql.DocumentTagLink(document_id=doc_id, tag_id=tag_id)
            self.session.merge(link)
            self.session.commit()
            return True
        except Exception as e:
            print(e)
            self.session.rollback()
            return False

    def get_wandering_files(self, base_path: Union[str, Path]) -> set[Path]:
        base_path = Path(base_path)
        if not base_path.exists():
            return set()
        local_files = {fi.name for fi in base_path.iterdir() if fi.is_file()}
        db_files = {file for file in self.session.exec(sqlmodel.select(document_sql.Document.file_path)).all()}
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
        doc = idb.search_by_file(test_file)
        if not doc:
            raise FileNotFoundError(f'文件 {test_file.name} 在数据库中未找到记录')
        assert doc.document_id is not None, "Document ID should not be None for existing file record"
        if not doc:
            print(f'文件 {test_file.name} 未在数据库记录，跳过')
            continue

        shutil.move(test_file, new_file_path)
        print(f'Moved: {test_file.name} -> {new_filename}')

        res = idb.edit_document(doc.document_id, filepath=new_file_path)
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
        doc = idb.search_by_source(str(ihid))
        if not doc:
            print(f'Hitomi ID {ihid} 未在数据库中找到')
            continue
        assert doc.document_id is not None, "Document ID should not be None for existing record"

        print(f'Downloading {ihid}...')
        temp_file_path = temp_document_content_path / Path(f'{ihid}.zip')
        comic_file = open(temp_file_path, 'wb')
        try:
            document = await hitomiv2.getComic(ihid)
            if not document:
                raise RuntimeError(f"Document with Hitomi ID {ihid} not found in hitomiv2")
            dl_result = await hitomiv2.downloadComic(document, comic_file, max_threads=5)  # 假设返回文件路径字符串
            if not dl_result:
                raise RuntimeError("Download failed")

            file_hash = await get_file_hash(temp_file_path)
            new_name = f"{file_hash}.zip"
            target_path = archived_document_path / new_name

            # 检查此哈希是否已存在于其他文档
            exist_doc = idb.search_by_file(new_name)
            if exist_doc:
                print(f'Hash {new_name} 已经存在于 ID {exist_doc}')
                raise FileExistsError
            comic_file.close()
            shutil.move(temp_file_path, target_path)
            idb.edit_document(doc.document_id, filepath=target_path)
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
    document = db.get_document_by_id(document_id)
    if not document:
        raise FileNotFoundError(f'Document id {document_id} not found')
    # noinspection PyTypeChecker
    statement = (
        sqlmodel.select(document_sql.DocumentSourceLink, document_sql.Source)
        .join(document_sql.Source, sqlmodel.col(document_sql.DocumentSourceLink.source_id) == document_sql.Source.source_id)
        .where(document_sql.DocumentSourceLink.document_id == document_id)
    )
    link, source = db.session.exec(statement).one()
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


if __name__ == '__main__':
    if len(sys.argv) <= 1:
        exit(1)

    cmd_g = sys.argv[1]

    with DocumentDB() as db_g:
        if cmd_g == 'clean':
            if not archived_document_path:
                print("Archived path not set")
                exit(1)
            wandering_files_g = db_g.get_wandering_files(archived_document_path)
            print(f"Found {len(wandering_files_g)} unlinked files.")
            if input("Delete them? (y/n): ") == 'y':
                for f in wandering_files_g:
                    f.unlink()
                    print(f"Deleted {f.name}")
        elif cmd_g == 'fix_hash':
            if not archived_document_path:
                print("Archived path not set")
                exit(1)
            asyncio.run(fix_file_hash(db_g, archived_document_path))
        elif cmd_g == 'hitomi_update':
            try:
                hitomi_id_g = int(sys.argv[2])
                asyncio.run(update_hitomi_file_hash([hitomi_id_g], db_g))
            except (IndexError, ValueError):
                print("Invalid Hitomi ID")
        elif cmd_g == 'export':
            document_id_g = int(sys.argv[2])
            with open(f'{document_id_g}.zip', 'wb+') as ef:
                asyncio.run(export_portable_document(document_id_g, db_g, ef))
        elif cmd_g == 'edit':
            if len(sys.argv) < 4:
                print("用法: python document_db.py edit <document_id> key=value ...")
                print("支持的字段: title, file_path, series_name, volume_number, authors")
                print("示例: python document_db.py edit 42 title=\"New Title\" volume_number=3")
                print("      python document_db.py edit 42 authors=\"作者A,作者B\"")
                exit(1)
            try:
                doc_id_g = int(sys.argv[2])
            except ValueError:
                print(f"无效的文档ID: {sys.argv[2]}")
                exit(1)

            doc_g = db_g.get_document_by_id(doc_id_g)
            if not doc_g:
                print(f"文档 ID {doc_id_g} 不存在")
                exit(1)

            valid_keys = {'title', 'file_path', 'series_name', 'volume_number', 'authors'}
            kwargs_g = {}
            for arg_g in sys.argv[3:]:
                if '=' not in arg_g:
                    print(f"无效参数: {arg_g}, 需要 key=value 格式")
                    exit(1)
                k_g, v_g = arg_g.split('=', 1)
                if k_g not in valid_keys:
                    print(f"未知字段: {k_g}")
                    print(f"支持的字段: {', '.join(sorted(valid_keys))}")
                    exit(1)
                kwargs_g[k_g] = v_g

            # 显示当前值
            print(f"文档 ID {doc_id_g}: {doc_g.title}")
            print(f"  file_path: {doc_g.file_path}")
            print(f"  series_name: {doc_g.series_name}")
            print(f"  volume_number: {doc_g.volume_number}")
            print(f"  authors: {', '.join(a.name for a in doc_g.authors)}")
            print()

            # 映射到 edit_document 参数
            edit_kwargs_g = {}
            for k_g, v_g in kwargs_g.items():
                if k_g == 'title':
                    edit_kwargs_g['title'] = v_g
                elif k_g == 'file_path':
                    edit_kwargs_g['filepath'] = v_g
                    edit_kwargs_g['verify_file'] = False
                elif k_g == 'series_name':
                    edit_kwargs_g['series'] = v_g if v_g else None
                elif k_g == 'volume_number':
                    edit_kwargs_g['volume'] = int(v_g) if v_g else None
                elif k_g == 'authors':
                    edit_kwargs_g['authors'] = [a.strip() for a in v_g.split(',')]
                print(f"  {k_g}: {getattr(doc_g, k_g, None)} -> {v_g}")

            res_g = db_g.edit_document(doc_id_g, **edit_kwargs_g)
            if res_g == 0:
                print("修改成功")
            else:
                print(f"修改失败 Code: {res_g}")

        elif cmd_g == 'test':
            # 简单的测试逻辑
            cnt_g = len(db_g.get_all_document_ids())
            print(f"Database connected. Total documents: {cnt_g}")


def get_db():
    with DocumentDB() as db:
        yield db
