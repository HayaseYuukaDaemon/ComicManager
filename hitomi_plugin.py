import asyncio
from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
import document_sql
import hitomiv2
import log_comic
from pathlib import Path
from site_utils import Authoricator, task_status, TaskStatus, UserAbilities
import document_db
from document_db import get_db
import shutil
from pydantic import BaseModel
from typing import Optional
from setup_logger import getLogger

logger, setLoggerLevel, _ = getLogger('HitomiPlugin')


class AddComicRequest(BaseModel):
    source_document_id: str
    inexistent_tags: Optional[dict[str, tuple[Optional[int], str]]] = None


class AddComicResponse(BaseModel):
    message: Optional[str] = None
    redirect_url: Optional[str] = None


# --- 后台任务逻辑 ---
async def refresh_hitomi_loop():
    logger.info("Hitomi 后台刷新任务已启动")
    while True:
        try:
            try:
                await hitomiv2.refreshVersion()
            except Exception as e:
                logger.exception(f"Hitomi 刷新失败，将在下个周期重试。", exc_info=e)
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            break


async def implement_document(comic: hitomiv2.Comic, tags: list[document_sql.Tag]):
    comic_authors_raw = comic.artists
    comic_authors_list = []
    if not comic_authors_raw:
        comic_authors_list.append('佚名')
    else:
        for author in comic_authors_raw:
            comic_authors_list.append(author.artist)
    raw_comic_path = log_comic.RAW_PATH / Path(f'{comic.id}.zip')

    if raw_comic_path.exists():
        task_status[comic.title] = TaskStatus(percent=0, message='预下载文件已存在, 请求人工接管')
        return
    task_status[comic.title] = TaskStatus(percent=0)
    total_files_num = len(comic.files)
    done_nums = 0

    # noinspection PyUnusedLocal
    async def phase_callback(url: str):
        nonlocal done_nums
        done_nums += 1
        task_status[comic.title].percent = round(done_nums / total_files_num * 100, ndigits=2)

    try:
        with open(raw_comic_path, 'wb') as cf:
            dl_result = await hitomiv2.downloadComic(comic,
                                                     cf,
                                                     max_threads=5,
                                                     phase_callback=phase_callback,
                                                     enable_tempfile=False)
    except Exception as dl_e:
        dl_result = dl_e
    if dl_result is False:
        task_status[comic.title].message = '下载失败'
        raw_comic_path.unlink(missing_ok=True)
        return
    elif isinstance(dl_result, Exception):
        logger.exception(f'下载时抛出异常', exc_info=dl_result)
        task_status[comic.title].message = f'下载失败, 异常: {dl_result}'
        raw_comic_path.unlink(missing_ok=True)
        return

    comic_hash = await log_comic.get_file_hash(raw_comic_path)
    hash_name = f'{comic_hash}.zip'
    final_path = log_comic.archived_document_path / Path(hash_name)
    if final_path.exists():
        task_status[comic.title] = TaskStatus(percent=0, message='最终文件已存在, 请求人工接管')
        return
    with document_db.DocumentDB() as db:
        comic_id = db.add_document(comic.title, final_path, authors=comic_authors_list, check_file=False)
        if not comic_id or comic_id < 0:
            task_status[comic.title] = TaskStatus(percent=0, message=f'无法添加本子: {comic_id}')
            raw_comic_path.unlink()
            return
        for tag in tags:
            db.link_document_tag(comic_id, tag)
        link_result = db.link_document_source(comic_id, 1, str(comic.id))
        if not link_result:
            task_status[comic.title] = TaskStatus(percent=0, message='hitomi链接失败, 请求人工接管')
            return
    shutil.move(raw_comic_path, final_path)


router = APIRouter(tags=["Hitomi"])
document_router = APIRouter(tags=['Documents', 'API', 'Hitomi'])
tag_router = APIRouter(tags=['Tags', 'API', 'Hitomi'])
site_router = APIRouter(tags=['Site', 'APT', 'Hitomi'])


# noinspection PyUnusedLocal
@router.get('/hitomi/add',
            response_class=HTMLResponse,
            dependencies=[Depends(Authoricator())])
async def add_comic_ui(source_document_id: str):
    return FileResponse('templates/add_hitomi_comic.html')


@router.get('/hitomi',
            response_class=HTMLResponse,
            dependencies=[Depends(Authoricator())])
async def hitomi_ui():
    return FileResponse('templates/hitomi.html')


MAX_SEARCH_RESULTS = 10


@document_router.get('/search',
                     name='document.search.hitomi',
                     dependencies=[Depends(Authoricator())])
async def search_comic(search_str: str) -> list[hitomiv2.Comic]:
    result_ids = await hitomiv2.searchIDs(search_str + ' language:chinese', max_threads=5)
    if not result_ids:
        raise HTTPException(status_code=404, detail='未找到中文结果')
    if len(result_ids) > MAX_SEARCH_RESULTS:
        raise HTTPException(status_code=400, detail='结果过多')
    comics = [await hitomiv2.getComic(result_id) for result_id in result_ids]
    if not comics:
        raise HTTPException(status_code=500, detail='搜索结果有但是无法获取(?')
    return comics


@document_router.get('/get/{hitomi_id}',
                     name='document.get.hitomi',
                     dependencies=[Depends(Authoricator())])
async def get_comic(hitomi_id: int, db: document_db.DocumentDB = Depends(get_db)) -> document_sql.DocumentMetadata:
    document = db.search_by_source(str(hitomi_id), 1)
    if document is None:
        raise HTTPException(status_code=404)
    return document_sql.DocumentMetadata(document_info=document,
                                         document_tags=document.tags,
                                         document_pages=None,
                                         document_authors=document.authors)


@document_router.post('/add',
                      name='document.add.hitomi',
                      dependencies=[Depends(Authoricator([UserAbilities.CREATE_DOCUMENT,
                                                          UserAbilities.CREATE_TAG]))])
async def add_comic_post(request: AddComicRequest,
                         bg_tasks: BackgroundTasks,
                         db: document_db.DocumentDB = Depends(get_db)) -> AddComicResponse:
    try:
        hitomi_result = await hitomiv2.getComic(request.source_document_id)
    except Exception as e:
        return AddComicResponse(message=str(e))
    db_result = db.search_by_source(source_document_id=request.source_document_id)
    if db_result:
        task_status.pop(hitomi_result.title, None)
        return AddComicResponse(redirect_url=f'/show_document/{db_result.document_id}')
    raw_document_tags = log_comic.extract_generic_tags(hitomi_result)
    document_tags = []
    for tag in raw_document_tags:
        db_result = tag.query_db(db)
        if db_result:
            document_tags.append(db_result)
            continue
        tag_info_by_req = request.inexistent_tags.get(tag.hitomi_name, None)
        if tag_info_by_req is None:
            return AddComicResponse(message=f'tag {tag.hitomi_name} not found')
        if tag.group_id is None:
            tag.group_id = tag_info_by_req[0]
        if tag.group_id is None:
            return AddComicResponse(message=f'group {tag.hitomi_name} not found')
        if not tag_info_by_req[1]:
            return AddComicResponse(message=f'tag {tag.hitomi_name} name not found')
        tag.name = tag_info_by_req[1]
        try:
            db_result = tag.add_db(db)
        except Exception as e:
            return AddComicResponse(message=f'tag {tag.hitomi_name} db add failed: {str(e)}')
        document_tags.append(db_result)
    bg_tasks.add_task(implement_document, hitomi_result, document_tags)
    return AddComicResponse(redirect_url='/show_status')


class MissingTag(BaseModel):
    name: str
    group_id: Optional[int]


@tag_router.get('/missing_tags',
                dependencies=[Depends(Authoricator())],
                name='tags.get.hitomi.missing_tags')
async def get_missing_tags(source_document_id: str,
                           db: document_db.DocumentDB = Depends(get_db)) -> list[MissingTag]:
    db_result = db.search_by_source(source_document_id=source_document_id)
    if db_result:
        return []
    try:
        hitomi_result = await hitomiv2.getComic(source_document_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))
    if hitomi_result is None:
        raise HTTPException(status_code=404, detail=f'comic {source_document_id} not found')
    plain_tags = log_comic.extract_generic_tags(hitomi_result)
    tags: list[MissingTag] = []
    for tag in plain_tags:
        if tag.query_db(db):
            continue
        tags.append(MissingTag(name=tag.hitomi_name, group_id=tag.group_id))
    return tags


@site_router.get('/download_urls')
async def get_download_urls(hitomi_id: int) -> dict[str, str]:
    comic = await hitomiv2.getComic(str(hitomi_id))
    if not comic:
        raise HTTPException(status_code=404, detail=f'comic {hitomi_id} not found')
    return await hitomiv2.decodeDownloadUrls(comic.files)


router.include_router(tag_router, prefix='/api/tags/hitomi')
router.include_router(document_router, prefix='/api/documents/hitomi')
router.include_router(site_router, prefix='/api/site/hitomi')
