import os
from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
import fastapi
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
import httpx
import api_models as api
from setup_logger import getLogger
from utils import Authoricator, UserAbilities
from dmb import DMBClient
import tags
import comics
import sqlite3

logger, setLoggerLevel, _ = getLogger('Site')
tag_error_responses = {code: {"model": api.ErrorResponse} for code in (401, 403, 404, 409, 422)}
comics_api = fastapi.APIRouter(
    tags=['Comics', 'API'],
    responses={**tag_error_responses, 502: {"model": api.ErrorResponse}, 504: {"model": api.ErrorResponse}},
)
tag_router = fastapi.APIRouter(tags=['Tags', 'API'], responses=tag_error_responses) #type: ignore
site_router = fastapi.APIRouter(tags=['Site', 'API'])

COMIC_DB_PATH = Path(os.getenv('COMIC_DB_PATH', 'comics.db'))


def get_comic_manager() -> Iterator[comics.ComicManager]:
    # 同一个请求的依赖和路由可能运行在不同线程，但连接不跨请求共享。
    conn = sqlite3.connect(COMIC_DB_PATH, check_same_thread=False, timeout=5.0)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        yield comics.ComicManager(conn)
    finally:
        conn.close()


ComicManagerDep = Annotated[comics.ComicManager, fastapi.Depends(get_comic_manager)]


def get_dmb_client(request: fastapi.Request) -> DMBClient:
    return request.app.state.dmb_client


DMBClientDep = Annotated[DMBClient, fastapi.Depends(get_dmb_client)]

app_kwargs = {"docs_url": None, "redoc_url": None, "openapi_url": None}


@asynccontextmanager
async def lifespan(app_instance: fastapi.FastAPI):
    dmb_url = os.environ.get('DMB_URL')
    if dmb_url is None:
        raise RuntimeError("DMB_URL environment variable is not set. Please set it to the base URL of the DMB API.")
    with DMBClient(base_url=dmb_url) as client:
        await run_in_threadpool(client.check_health)
        app_instance.state.dmb_client = client
        try:
            yield
        finally:
            del app_instance.state.dmb_client


app_kwargs["lifespan"] = lifespan # type: ignore

app = fastapi.FastAPI(**app_kwargs) # type: ignore


class APIError(Exception):
    def __init__(self, status_code: int, code: str, message: str, **details):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def error_response(error: APIError) -> fastapi.responses.JSONResponse:
    return fastapi.responses.JSONResponse(
        status_code=error.status_code,
        content=jsonable_encoder({"error": {
            "code": error.code, "message": error.message, "details": error.details,
        }}),
    )


@app.exception_handler(APIError)
async def handle_api_error(request: fastapi.Request, error: APIError):
    return error_response(error)


@app.exception_handler(tags.MetaSchemaViolationError)
async def handle_meta_schema_error(request: fastapi.Request, error: tags.MetaSchemaViolationError):
    return error_response(APIError(
        422, "META_SCHEMA_VIOLATION", "来源标签的 metadata schema 与数据库不一致",
        specific_tag=error.specific_tag,
        db_schema_hash=error.db_schema_hash, tag_schema_hash=error.tag_schema_hash,
    ))


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: fastapi.Request, error: RequestValidationError):
    if not request.url.path.startswith(("/api/tags", "/api/comics")):
        return await request_validation_exception_handler(request, error)
    errors = [{key: item[key] for key in ("loc", "msg", "type")} for item in error.errors()]
    code = "INVALID_SPECIFIC_TAG" if any("specific_tag" in item["loc"] for item in errors) else "INVALID_REQUEST"
    return error_response(APIError(422, code, "请求参数不符合接口要求", errors=errors))


@app.exception_handler(fastapi.HTTPException)
async def handle_http_error(request: fastapi.Request, error: fastapi.HTTPException):
    if not request.url.path.startswith(("/api/tags", "/api/comics")):
        return await http_exception_handler(request, error)
    code = {401: "AUTHENTICATION_REQUIRED", 403: "FORBIDDEN"}.get(error.status_code, f"HTTP_{error.status_code}")
    response = error_response(APIError(error.status_code, code, str(error.detail)))
    response.headers.update(error.headers or {})
    return response


@app.get("/openapi.json",
         include_in_schema=False,
         dependencies=[fastapi.Depends(Authoricator())])
async def get_open_api_endpoint():
    return fastapi.responses.JSONResponse(get_openapi(title="ComicManagerAPI", version="1.0.0", routes=app.routes))


@app.get("/docs",
         include_in_schema=False,
         dependencies=[fastapi.Depends(Authoricator())])
async def get_documentation():
    return get_swagger_ui_html(openapi_url="/openapi.json", title="docs")


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


@app.get('/auth', include_in_schema=False)
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


@site_router.get('/status/show',
         response_class=fastapi.responses.HTMLResponse,
         dependencies=[fastapi.Depends(Authoricator())])
async def get_download_status():
    # 这个接口是给前端直接访问的, 返回html页面, 里面有js轮询status接口来获取下载状态
    return fastapi.responses.FileResponse('templates/show_download_status.html')


@site_router.get('/status',
                 dependencies=[fastapi.Depends(Authoricator())],
                 name='site.get_download_status')
async def get_status() -> dict:
    # 这接口是给前端轮询用的, 直接返回json就行, 不需要返回html
    # 记得加类型提示
    return {}


@tag_router.get('/groups',
                dependencies=[fastapi.Depends(Authoricator())],
                name='tags.get_groups')
async def get_tag_groups() -> list[str]:
    return list(tags.TagGroup)

specific_tag_router = fastapi.APIRouter(tags=['Tags', 'API', 'SpecificTag'])
generic_tag_router = fastapi.APIRouter(tags=['Tags', 'API', 'GenericTag'])


def require_generic_tag(tag_id: int, comic_manager: comics.ComicManager) -> tags.GenericTag:
    tag = comic_manager.tag_manager.get_generic_tag(tag_id)
    if tag is None:
        raise APIError(404, "GENERIC_TAG_NOT_FOUND", "通用标签不存在", generic_tag_id=tag_id)
    return tag


def require_specific_tag(tag_id: int, comic_manager: comics.ComicManager) -> tags.SpecificTagUnion:
    tag = comic_manager.tag_manager.get_specific_tag(tag_id)
    if tag is None:
        raise APIError(404, "SPECIFIC_TAG_NOT_FOUND", "来源标签不存在", specific_tag_id=tag_id)
    return tag


@generic_tag_router.post('/query', dependencies=[fastapi.Depends(Authoricator())])
def query_generic_tags(
    query: api.GenericTagQuery, response: fastapi.Response, comic_manager: ComicManagerDep,
) -> list[int]:
    ids, total = comic_manager.tag_manager.query_generic_tag_ids(
        query.tag_group, query.name, name_match=query.name_match, limit=query.limit, offset=query.offset,
    )
    response.headers['X-Total-Count'] = str(total)
    return ids


@generic_tag_router.post('', status_code=201,
                         dependencies=[fastapi.Depends(Authoricator([UserAbilities.CREATE_TAG]))])
def create_generic_tag(payload: tags.GenericTag, comic_manager: ComicManagerDep) -> tags.GenericTag:
    manager = comic_manager.tag_manager
    try:
        return manager.create_generic_tag(payload.name, payload.tag_group)
    except tags.GenericTagExistsError:
        raise APIError(409, "GENERIC_TAG_EXISTS", "同组同名的通用标签已存在")


@generic_tag_router.get('/{tag_id}', dependencies=[fastapi.Depends(Authoricator())])
def get_generic_tag(tag_id: int, comic_manager: ComicManagerDep) -> tags.GenericTag:
    return require_generic_tag(tag_id, comic_manager)


@generic_tag_router.get('/{tag_id}/specifics', dependencies=[fastapi.Depends(Authoricator())])
def get_generic_tag_specifics(
    tag_id: int,
    response: fastapi.Response,
    comic_manager: ComicManagerDep,
    limit: int = fastapi.Query(default=50, ge=1, le=100),
    offset: int = fastapi.Query(default=0, ge=0),
) -> list[int]:
    require_generic_tag(tag_id, comic_manager)
    ids, total = comic_manager.tag_manager.get_generic_tag_specific_ids(tag_id, limit=limit, offset=offset)
    response.headers['X-Total-Count'] = str(total)
    return ids


@specific_tag_router.post('/query', dependencies=[fastapi.Depends(Authoricator())])
def query_specific_tags(
    query: api.SpecificTagQuery, response: fastapi.Response, comic_manager: ComicManagerDep,
) -> list[int]:
    manager = comic_manager.tag_manager
    if isinstance(query, api.SpecificTagExactQuery):
        tag = query.specific_tag
        manager.validate_meta_schema(tag)
        ids, total = manager.query_specific_tag_ids(tag.site, tag.origin_name, tag.dump_specific_json(), limit=1)
    else:
        ids, total = manager.query_specific_tag_ids(
            query.site, query.origin_name, limit=query.limit, offset=query.offset,
        )
    response.headers['X-Total-Count'] = str(total)
    return ids


@specific_tag_router.post('', status_code=201,
                          dependencies=[fastapi.Depends(Authoricator([UserAbilities.CREATE_TAG]))])
def create_specific_tag(
    payload: api.SpecificTagCreate, response: fastapi.Response, comic_manager: ComicManagerDep,
) -> tags.SpecificTagUnion:
    manager = comic_manager.tag_manager
    generic = require_generic_tag(payload.generic_tag_id, comic_manager)
    try:
        manager.create_specific_tag(payload.specific_tag, generic)
    except tags.SpecificTagExistsError:
        if manager.generalize(payload.specific_tag) != generic:
            raise APIError(
                409, "SPECIFIC_TAG_MAPPING_CONFLICT", "该来源标签已经映射到其他通用标签",
            )
        response.status_code = 200
    return payload.specific_tag

@specific_tag_router.get('/{tag_id}', 
                         dependencies=[fastapi.Depends(Authoricator())], 
                         name='tags.get_specific_tag')
def get_specific_tag(tag_id: int, comic_manager: ComicManagerDep) -> tags.SpecificTagUnion:
    return require_specific_tag(tag_id, comic_manager)

@specific_tag_router.get('/{tag_id}/generic', 
                         dependencies=[fastapi.Depends(Authoricator())], 
                         name='tags.get_mapped_generic_tag')
def get_mapped_generic_tag(tag_id: int, comic_manager: ComicManagerDep) -> tags.GenericTag:
    return comic_manager.tag_manager.generalize(require_specific_tag(tag_id, comic_manager))

tag_router.include_router(specific_tag_router, prefix='/specific')
tag_router.include_router(generic_tag_router, prefix='/generic')


@comics_api.get('',
                dependencies=[fastapi.Depends(Authoricator())],
                name='comics.list_comics')
def list_comics(
    response: fastapi.Response,
    comic_manager: ComicManagerDep,
    limit: int = fastapi.Query(default=50, ge=1, le=100),
    offset: int = fastapi.Query(default=0, ge=0),
) -> list[comics.Comic]:
    """按 ID 升序读取 CM 库中的原始 Comic；总数通过 X-Total-Count 返回。"""
    result, total = comic_manager.list_comics(limit=limit, offset=offset)
    response.headers['X-Total-Count'] = str(total)
    response.headers['Cache-Control'] = 'no-store'
    return result


@comics_api.post('/query',
                 dependencies=[fastapi.Depends(Authoricator())],
                 name='comics.query_comics')
def query_comics(
    payload: api.ComicQuery, response: fastapi.Response, comic_manager: ComicManagerDep,
) -> list[comics.Comic]:
    """按通用标签、作者及标题组合检索；返回原始 Comic，匹配总数在 X-Total-Count。"""
    result, total = comic_manager.query_comics(**payload.model_dump())
    response.headers['X-Total-Count'] = str(total)
    response.headers['Cache-Control'] = 'no-store'
    return result


@comics_api.get('/{comic_id}',
                dependencies=[fastapi.Depends(Authoricator())],
                name='comics.get_comic')
def get_comic(
    comic_id: Annotated[int, fastapi.Path(ge=0, le=2**63 - 1)],
    response: fastapi.Response, comic_manager: ComicManagerDep,
) -> comics.Comic:
    """按 ID 读取 CM 中的原始 Comic，不访问 DMB。"""
    comic = comic_manager.get_comic(comic_id)
    if comic is None:
        raise APIError(404, "COMIC_NOT_FOUND", "漫画未入库", comic_id=comic_id)
    response.headers['Cache-Control'] = 'no-store'
    return comic


def fetch_comic_source(
    comic_id: int, comic_manager: comics.ComicManager, dmb_client: DMBClient,
) -> comics.Comic:
    try:
        comic_data = dmb_client.fetch_comic_info(str(comic_id))
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            raise APIError(404, "SOURCE_DOCUMENT_NOT_FOUND", "DMB 归档记录不存在", comic_id=comic_id) from error
        raise APIError(502, "SOURCE_SERVICE_ERROR", "DMB 返回错误响应", upstream_status=error.response.status_code) from error
    except httpx.TimeoutException as error:
        raise APIError(504, "SOURCE_SERVICE_TIMEOUT", "读取 DMB 归档数据超时") from error
    except httpx.RequestError as error:
        raise APIError(502, "SOURCE_SERVICE_ERROR", "无法读取 DMB 归档数据") from error
    except ValueError as error:
        raise APIError(422, "INVALID_SOURCE_METADATA", "DMB 响应不是有效 JSON") from error

    try:
        document = api.SourceDocument.model_validate(comic_data)
        if document.document_id != comic_id:
            raise ValueError("DMB returned a different document_id")
        comic = comic_manager.create_comic(document.source, comic_id, document.source_meta)
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise APIError(422, "INVALID_SOURCE_METADATA", "来源 metadata 无法解析为漫画", reason=str(error)) from error
    return comic


@comics_api.get('/{comic_id}/preview',
                dependencies=[fastapi.Depends(Authoricator())],
                name='comics.get_comic_preview')
def get_comic_preview(
    comic_id: int, response: fastapi.Response,
    comic_manager: ComicManagerDep, dmb_client: DMBClientDep,
) -> comics.Comic:
    comic = fetch_comic_source(comic_id, comic_manager, dmb_client)
    response.headers['Cache-Control'] = 'no-store'
    return comic

@comics_api.post('/{comic_id}/commit',
                 status_code=201,
                 dependencies=[fastapi.Depends(Authoricator([UserAbilities.CREATE_DOCUMENT]))],
                 name='comics.commit_comic')
def commit_comic(
    comic_id: int,
    comic_manager: ComicManagerDep, dmb_client: DMBClientDep, allow_override: bool = False,
) -> comics.Comic:
    comic = fetch_comic_source(comic_id, comic_manager, dmb_client)
    missing = comic_manager.get_missing_tags(comic)
    if missing:
        raise APIError(409, "UNMAPPED_SPECIFIC_TAGS", "存在尚未映射的来源标签", specific_tags=missing)
    try:
        comic_manager.add_comic(comic, allow_override=allow_override)
    except comics.ComicIDExistsError as error:
        raise APIError(409, "COMIC_ALREADY_EXISTS", "该漫画已经录入", comic_id=comic_id) from error
    except tags.SpecificTagNotFoundError as error:
        # A mapping may disappear between preflight and the transaction; add_comic rolls back.
        raise APIError(409, "UNMAPPED_SPECIFIC_TAGS", "录入时来源标签映射已失效", specific_tags=[error.specific_tag]) from error
    return comic

@app.get('/exploror',
         response_class=fastapi.responses.HTMLResponse,
         dependencies=[fastapi.Depends(Authoricator())])
def exploror():
    return fastapi.responses.FileResponse(path='templates/exploror.html')


@app.get('/dmb-viewer.html',
         response_class=fastapi.responses.HTMLResponse,
         dependencies=[fastapi.Depends(Authoricator())])
def dmb_viewer():
    return fastapi.responses.FileResponse(path='templates/dmb-viewer.html')


@app.get('/', dependencies=[fastapi.Depends(Authoricator())])
async def root():
    return fastapi.responses.RedirectResponse(url='/exploror', status_code=fastapi.status.HTTP_303_SEE_OTHER)


app.include_router(comics_api, prefix='/api/comics')
app.include_router(tag_router, prefix='/api/tags')
app.include_router(site_router, prefix='/api/site')
