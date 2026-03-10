import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import fastapi
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel
import document_sql
import document_db
from document_db import get_db
from setup_logger import getLogger
from site_utils import (archived_document_path,
                        get_zip_namelist,
                        create_content_response,
                        Authoricator,
                        UserAbilities,
                        PAGE_COUNT,
                        task_status,
                        TaskStatus)

logger, setLoggerLevel, _ = getLogger('Site')
document_router = fastapi.APIRouter(tags=['Documents', 'API'])
tag_router = fastapi.APIRouter(tags=['Tags', 'API'])
site_router = fastapi.APIRouter(tags=['Site', 'API'])
hitomi_router: fastapi.APIRouter | None = None

try:
    import hitomi_plugin

    hitomi_router = hitomi_plugin.router
    logger.info("Hitomi 插件加载成功")
except ImportError as e:
    logger.info(f"Hitomi 插件未加载: {e}")
    hitomi_plugin = None

app_kwargs = {"docs_url": None, "redoc_url": None, "openapi_url": None}


# noinspection PyUnusedLocal
@asynccontextmanager
async def lifespan(app_instance: fastapi.FastAPI):
    # 如果插件存在，启动插件的后台任务
    hitomi_bg_task = None
    if hitomi_plugin:
        hitomi_bg_task = asyncio.create_task(hitomi_plugin.refresh_hitomi_loop())
    yield
    # 清理任务
    if hitomi_bg_task:
        hitomi_bg_task.cancel()
        try:
            await hitomi_bg_task
        except Exception as le:
            logger.error(str(le))


# noinspection PyTypeChecker
app_kwargs["lifespan"] = lifespan

app = fastapi.FastAPI(**app_kwargs)


@app.get("/openapi.json",
         include_in_schema=False,
         dependencies=[fastapi.Depends(Authoricator())])
async def get_open_api_endpoint():
    return fastapi.responses.JSONResponse(get_openapi(title="DocumentManagerAPI", version="1.0.0", routes=app.routes))


# 4. 手动实现 /docs，并加上依赖保护
@app.get("/docs",
         include_in_schema=False,
         dependencies=[fastapi.Depends(Authoricator())])
async def get_documentation():
    return get_swagger_ui_html(openapi_url="/openapi.json", title="docs")


# noinspection PyUnusedLocal
@app.get("/admin/{subpath:path}", include_in_schema=False)
async def admin(subpath: str = ""):
    return fastapi.responses.FileResponse(
        path='boom.gz',
        media_type='text/html',
        headers={
            'Content-Encoding': 'gzip',
            'Vary': 'Accept-Encoding'
        }
    )


@app.get('/HayaseYuuka',
         include_in_schema=False)
async def get_auth():
    return fastapi.responses.FileResponse(path='templates/auth.html')


@app.get('/favicon.ico', include_in_schema=False)
async def give_icon() -> fastapi.responses.FileResponse:
    return fastapi.responses.FileResponse(path='favicon.ico')


@app.get('/src/{filename}',
         response_class=fastapi.responses.FileResponse,
         dependencies=[fastapi.Depends(Authoricator())],
         name='site.get_src')
async def give_src(filename: str) -> fastapi.responses.FileResponse:
    file_path = Path(f'src/{filename}')
    if not file_path.exists():
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND)
    return fastapi.responses.FileResponse(path=file_path)


@app.get('/show_status',
         response_class=fastapi.responses.HTMLResponse,
         dependencies=[fastapi.Depends(Authoricator())])
async def get_download_status():
    return fastapi.responses.FileResponse('templates/show_download_status.html')


@site_router.get('/statistics',
                 dependencies=[fastapi.Depends(Authoricator())],
                 name='site.get_statistics')
async def get_statistics(db: document_db.DocumentDB = fastapi.Depends(get_db)) -> document_sql.SiteStatistics:
    return await db.get_statistics()


@site_router.get('/co_occurrence',
                 dependencies=[fastapi.Depends(Authoricator())],
                 name='site.get_co_occurrence')
async def get_co_occurrence(db: document_db.DocumentDB = fastapi.Depends(get_db)) -> document_sql.CoOccurrenceResult:
    return await db.get_co_occurrences()


@site_router.get('/download_status',
                 dependencies=[fastapi.Depends(Authoricator())],
                 name='site.get_download_status')
async def get_status() -> dict[str, TaskStatus]:
    return task_status


class SearchDocumentResponse(BaseModel):
    results: list[int]
    total_count: int


@document_router.get('/',
                     dependencies=[fastapi.Depends(Authoricator())],
                     name='document.search')
async def search_document(target_tag: int | None = None,
                    page: int | None = None,
                    author_name: str | None = None,
                    source_document_id: str | None = None,
                    source_id: int | None = None,
                    db: document_db.DocumentDB = fastapi.Depends(get_db)) -> SearchDocumentResponse:
    if page is None:
        target_page = 1
    else:
        target_page = page
    if source_document_id:
        try:
            documents_info = await db.search_by_source(source_document_id, source_id=source_id)
        except ReferenceError as ref_err:
            raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST, detail=str(ref_err))
        total_count = 1
    elif target_tag:
        total_count, documents_info = await db.paginate_query(db.query_by_tags([target_tag]),
                                                        target_page, PAGE_COUNT)
    elif author_name:
        total_count, documents_info = await db.paginate_query(db.query_by_author(author_name),
                                                        target_page, PAGE_COUNT)
    else:
        total_count, documents_info = await db.paginate_query(db.query_all_documents(), target_page, PAGE_COUNT)
    search_results = [document.document_id for document in documents_info]
    return SearchDocumentResponse(results=search_results, total_count=total_count)


@document_router.post('/',
                      name='document.add')
def add_document(payload: dict = fastapi.Body()):
    source_id = payload.get('source_id', None)
    if source_id is None:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST)
    if source_id == 1:
        return fastapi.responses.RedirectResponse(url='/api/documents/hitomi/add',
                                                  status_code=fastapi.status.HTTP_307_TEMPORARY_REDIRECT)
    raise fastapi.HTTPException(status_code=fastapi.status.HTTP_501_NOT_IMPLEMENTED)


@document_router.get('/{document_id}',
                     dependencies=[fastapi.Depends(Authoricator())],
                     name='document.get_metadata')
async def get_document_matadata(document_id: int,
                          db: document_db.DocumentDB = fastapi.Depends(get_db)) -> document_sql.DocumentMetadata:
    if document_id < 0:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST, detail='自己输了啥心里有数')
    document = await db.get_document_by_id(document_id)
    if document is None:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND, detail='数据库中不存在此文件')
    file_path = archived_document_path / document.file_path
    if not file_path.exists():
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND, detail='数据库有, 本地不存在')
    pic_list = get_zip_namelist(file_path)
    if isinstance(pic_list, str):
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND, detail=pic_list)
    if document.title in task_status:
        task_status.pop(document.title)
    return document_sql.DocumentMetadata(
        document_pages=[f'/api/documents/{document_id}/page/{i}' for i in range(len(pic_list))],
        document_info=document,
        document_tags=document.tags,
        document_authors=document.authors
    )


@document_router.delete('/{document_id}', name='document.delete')
async def delete_document(document_id: int,
                    user=fastapi.Depends(Authoricator([UserAbilities.DELETE_DOCUMENT])),
                    db: document_db.DocumentDB = fastapi.Depends(get_db)):
    result = await db.delete_document(document_id)
    if result != 0:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST, detail='文档不存在')
    return fastapi.responses.Response(status_code=fastapi.status.HTTP_200_OK)


@document_router.get('/{document_id}/page/{content_index}',
                     response_class=fastapi.responses.FileResponse,
                     responses={
                         fastapi.status.HTTP_304_NOT_MODIFIED: {
                             "description": "资源未修改，使用本地缓存",
                             "content": {}
                         },
                         fastapi.status.HTTP_200_OK: {"description": "返回内容"}
                     },
                     dependencies=[fastapi.Depends(Authoricator())],
                     name='document.get_content')
async def get_document_content(request: fastapi.Request,
                         document_id: int,
                         content_index: int,
                         db: document_db.DocumentDB = fastapi.Depends(get_db)) -> fastapi.responses.Response:
    if document_id < 0:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST)
    if content_index < -1:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST)
    document = await db.get_document_by_id(document_id)
    if document is None:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND)
    file_path = archived_document_path / document.file_path
    if not file_path.exists():
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND)
    return create_content_response(request, document, content_index)


@document_router.get('/{document_id}/thumbnail',
                     response_class=fastapi.responses.FileResponse,
                     responses={
                         fastapi.status.HTTP_304_NOT_MODIFIED: {
                             "description": "资源未修改，使用本地缓存",
                             "content": {}
                         },
                         fastapi.status.HTTP_200_OK: {"description": "返回内容"}
                     },
                     dependencies=[fastapi.Depends(Authoricator())],
                     name='document.get_content')
async def get_document_thmubnail(request: fastapi.Request,
                           document_id: int,
                           db: document_db.DocumentDB = fastapi.Depends(get_db)) -> fastapi.responses.Response:
    if document_id < 0:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST)
    document = await db.get_document_by_id(document_id)
    if document is None:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND)
    file_path = archived_document_path / document.file_path
    if not file_path.exists():
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND)
    return create_content_response(request, document, 0)


@tag_router.get('/',
                dependencies=[fastapi.Depends(Authoricator())],
                name='tags.search')
async def get_tags(group_id: int | None = None, db: document_db.DocumentDB = fastapi.Depends(get_db)) -> dict[str, int | None] | dict[int, str]:
    logger.debug('收到tag查询')
    if group_id is None:
        return {tag_group.tag_group_id: tag_group.group_name for tag_group in await db.get_tag_groups()}
    if group_id < 0:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST)
    logger.debug(f'为请求{group_id}查询数据库')
    db_result = await db.get_tags_by_group(group_id)
    if not db_result:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND,
                                    detail=f'不存在id为{group_id}的tag组')
    return {t.name: t.tag_id for t in db_result}


@tag_router.get('/{tag_id}',
                dependencies=[fastapi.Depends(Authoricator())],
                name='tags.get')
async def get_tag(tag_id: int, db: document_db.DocumentDB = fastapi.Depends(get_db)) -> document_sql.Tag:
    logger.debug('收到tag检索')
    if tag_id < 0:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_400_BAD_REQUEST,
                                    detail='你是人类吗?')
    tag = await db.get_tag(tag_id)
    if tag is None:
        raise fastapi.HTTPException(status_code=fastapi.status.HTTP_404_NOT_FOUND,
                                    detail='没有这个tag')
    return tag



@app.get('/show_document/{document_id}',
         response_class=fastapi.responses.HTMLResponse,
         dependencies=[fastapi.Depends(Authoricator())])
def show_document():
    return fastapi.responses.FileResponse('templates/gallery.html')


@app.get('/exploror',
         response_class=fastapi.responses.HTMLResponse,
         dependencies=[fastapi.Depends(Authoricator())])
def exploror():
    return fastapi.responses.FileResponse(path='templates/exploror.html')


@app.get('/', dependencies=[fastapi.Depends(Authoricator())])
async def root():
    return fastapi.responses.RedirectResponse(url='/exploror', status_code=fastapi.status.HTTP_303_SEE_OTHER)


if hitomi_router:
    app.include_router(hitomi_router)
app.include_router(document_router, prefix='/api/documents')
app.include_router(tag_router, prefix='/api/tags')
app.include_router(site_router, prefix='/api/site')
