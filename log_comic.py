import asyncio
import os.path
import re
import shutil
import sys
from pathlib import Path
from typing import Optional, Self
import aioconsole
import document_db
import document_sql
import hitomiv2
from hitomiv2 import Tag, Parody, Character, Comic, downloadComic, getComic
from site_utils import archived_document_path, get_file_hash

RAW_PATH = Path('raw_document')
if not RAW_PATH.exists():
    RAW_PATH.mkdir()


def extract_hitomi_id(hitomi_url: str) -> Optional[str]:
    __match = re.search(r'(\d+)\.html$', hitomi_url)
    if __match:
        print('检测到HitomiURL')
        print(f'提取出的目标ID为:{__match.group(1)}')
        return __match.group(1)
    return None


class HitomiGenericTag:
    def __init__(self, tag: Tag | Parody | Character) -> None:
        self.tag = tag
        self.group_id: Optional[int] = None
        self.name: Optional[str] = None
        self.hitomi_name: Optional[str] = None
        self.db_id: Optional[int] = None
        if isinstance(tag, Tag):
            self.hitomi_name = tag.tag
            return
        if isinstance(tag, Parody):
            self.hitomi_name = tag.parody
            self.group_id = 1
            return
        if isinstance(tag, Character):
            self.hitomi_name = tag.character
            self.group_id = 2
            return
        raise TypeError(f'tag must be Tag or Parody or Character')

    def query_db(self, db: document_db.DocumentDB) -> Optional[document_sql.Tag]:
        tag_info = db.get_tag_by_hitomi(self.hitomi_name)
        if tag_info is None:
            return None
        self.name = tag_info.name
        self.group_id = tag_info.group_id
        self.db_id = tag_info.tag_id
        return tag_info

    def add_db(self, db: document_db.DocumentDB) -> document_sql.Tag:
        db_result = self.query_db(db)
        if db_result:
            return db_result
        if self.name is None:
            raise ValueError(f'未设置数据库名称')
        if self.group_id is None:
            raise ValueError(f'未分配组id')
        return db.add_tag(document_sql.Tag(name=self.name, group_id=self.group_id, hitomi_alter=self.hitomi_name))

    def __str__(self):
        if self.group_id == 1:
            return f'世界观: {self.hitomi_name}'
        elif self.group_id == 2:
            return f'人物: {self.hitomi_name}'
        elif self.group_id == 4:
            return f'冲点: {self.hitomi_name}'
        elif self.group_id == 6:
            return f'发行模式: {self.hitomi_name}'
        elif self.group_id == 7:
            return f'发行展会: {self.hitomi_name}'
        else:
            return f'未知tag: {self.hitomi_name}'

    def __hash__(self):
        return hash(self.hitomi_name)

    def __eq__(self, other: Self):
        if not isinstance(other, HitomiGenericTag):
            raise TypeError(f'不支持的比较')
        return self.hitomi_name == other.hitomi_name


def extract_generic_tags(comic: Comic) -> set[HitomiGenericTag]:
    result = set()
    for parody in comic.parodys:
        result.add(HitomiGenericTag(parody))
    for character in comic.characters:
        result.add(HitomiGenericTag(character))
    for tag in comic.tags:
        result.add(HitomiGenericTag(tag))
    return result


async def robust_input(prompt: str, validate_type: int) -> int | str:
    while True:
        result = await aioconsole.ainput(prompt)
        if validate_type:
            if result.isdigit():
                return int(result)
            print('请输入纯数字')
        else:
            if result:
                return result
            print(f'空输入')


async def implement_tags(comic: Comic, db: document_db.DocumentDB) -> list[document_sql.Tag]:
    raw_comic_tags = extract_generic_tags(comic)
    for tag_group in db.get_tag_groups():
        print(f'{tag_group.tag_group_id}:{tag_group.group_name}')
    comic_tags: list[document_sql.Tag] = []
    for tag in raw_comic_tags:
        db_result = tag.query_db(db)
        if db_result:
            comic_tags.append(db_result)
            continue
        print(tag)
        if tag.group_id is None:
            tag.group_id = await robust_input('输入tag组: ', 1)
        tag.name = await robust_input('输入tag名: ', 0)
        comic_tags.append(tag.add_db(db))
    return comic_tags


async def log_comic(db: document_db.DocumentDB, hitomi_id: int):
    if db.search_by_source(str(hitomi_id)):
        print('已存在')
        return
    comic = await getComic(hitomi_id)
    print(f'本子名: {comic.title}')
    print('开始录入tag')
    comic_tags = await implement_tags(comic, db)
    comic_authors_raw = comic.artists
    comic_authors_list = []
    if not comic_authors_raw:
        comic_authors_list.append('佚名')
        print(f'作者: 佚名')
    else:
        for author in comic_authors_raw:
            comic_authors_list.append(author.artist)
            print(f'作者: {author.artist}')

    print('信息录入完成，开始获取源文件')

    raw_comic_path = RAW_PATH / Path(f'{hitomi_id}.zip')
    dl_result = True
    if raw_comic_path.exists():
        print('检测到源文件已存在，跳过下载')
    else:
        with open(raw_comic_path, 'wb') as cf:
            dl_result = await downloadComic(comic, cf, max_threads=5)

    if not dl_result:
        print('下载失败')
        return

    comic_hash = await get_file_hash(raw_comic_path)
    hash_name = f'{comic_hash}.zip'
    final_path = archived_document_path / Path(hash_name)
    if final_path.exists():
        raise FileExistsError(f'文件 {final_path} 已存在')

    comic_id = db.add_document(comic.title, final_path, authors=comic_authors_list, check_file=False)
    if not comic_id or comic_id < 0:
        print(f'无法添加本子: {comic_id}')
        raw_comic_path.unlink()
        return
    print('开始链接tags')
    for tag in comic_tags:
        link_result = db.link_document_tag(comic_id, tag)
        if not link_result:
            print(f'tag {tag}链接失败，错误id: {link_result}')
    print('开始链接源')
    link_result = db.link_document_source(comic_id, 1, str(hitomi_id))
    if link_result:
        print(f'成功将本子与源ID{hitomi_id}链接')
    else:
        print('链接失败')
        return
    print('录入完成，移入完成文件夹')
    shutil.move(raw_comic_path, final_path)


if __name__ == '__main__':
    asyncio.run(hitomiv2.refreshVersion())
    id_iter = None
    task_list = []
    raw_file_list = os.listdir(RAW_PATH)
    if len(sys.argv) > 1:
        task_list += sys.argv
        del task_list[0]
    if raw_file_list:
        print('检测到有未完成录入，加入任务列表')
        for raw_file in raw_file_list:
            hitomi_id_g = raw_file.split('.')[0]
            task_list.append(hitomi_id_g)
    if len(task_list) > 0:
        id_iter = iter(task_list)
    while True:
        try:
            user_input = input('输入hitomi id: ') if id_iter is None else next(id_iter)
        except StopIteration:
            print('任务列表结束')
            id_iter = None
            continue
        if not user_input:
            print('结束录入')
            break
        if user_input.isdigit():
            hitomi_id_g = user_input
        else:
            extract_result = extract_hitomi_id(user_input)
            if not extract_result:
                print('输入错误')
                continue
            hitomi_id_g = extract_result
        with document_db.DocumentDB() as db_g:
            asyncio.run(log_comic(db_g, hitomi_id_g))
    print('录入完成')
