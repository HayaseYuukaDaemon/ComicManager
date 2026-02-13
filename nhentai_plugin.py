from setup_logger import getLogger
from fastapi import APIRouter, Depends, HTTPException
from site_utils import Authoricator
import document_db
from pydantic import BaseModel
from nhentai.parser import doujinshi_parser

logger, setLoggerLevel, _ = getLogger('NHentaiPlugin')

router = APIRouter(tags=["NHentai"])
document_router = APIRouter(tags=['Documents', 'API', 'NHentai'])
tag_router = APIRouter(tags=['Tags', 'API', 'NHentai'])
site_router = APIRouter(tags=['Site', 'API', 'NHentai'])


class MissingTag(BaseModel):
    name: str
    group_id: int | None


@tag_router.get('/missing_tags',
                dependencies=[Depends(Authoricator())],
                name='tags.get.hitomi.missing_tags')
async def get_missing_tags(source_document_id: str,
                           db: document_db.DocumentDB = Depends(document_db.get_db)) -> list[MissingTag]:
    db_result = db.search_by_source(source_document_id=source_document_id, source_id=2)
    if db_result:
        return []
    try:
        comic_info = doujinshi_parser(source_document_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))
    if comic_info is None:
        raise HTTPException(status_code=404, detail=f'comic {source_document_id} not found')
    plain_tags = log_comic.extract_generic_tags(hitomi_result)
    tags: list[MissingTag] = []
    for tag in plain_tags:
        if tag.query_db(db):
            continue
        tags.append(MissingTag(name=tag.hitomi_name, group_id=tag.group_id))
    return tags

router.include_router(tag_router, prefix='/api/tags/nhentai')
router.include_router(document_router, prefix='/api/documents/nhentai')
router.include_router(site_router, prefix='/api/site/nhentai')
