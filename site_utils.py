import enum
import hashlib
import os
from email.utils import formatdate
import pydantic
from pydantic import BaseModel
from typing import Optional
import natsort
import zipfile
import io
from pathlib import Path
from setup_logger import getLogger
import fastapi
import aiofiles
import json

archived_document_path = Path('archived_documents')
thumbnail_folder = Path('thumbnail')
logger, setLoggerLevel, _ = getLogger('SiteUtils')


class UserAbilities(enum.Enum):
    CREATE_DOCUMENT = 'document.create'
    DELETE_DOCUMENT = 'document.delete'
    CREATE_TAG = 'tag.create'
    DELETE_TAG = 'tag.delete'
    CREATE_SOURCE = 'source.create'


class UserInfo(BaseModel):
    username: str
    abilities: list[UserAbilities]
    admin: bool = False

    @property
    def is_admin(self):
        return self.admin

    def has_ability(self, ability: UserAbilities):
        return ability in self.abilities


class UserConfig(BaseModel):
    users: dict[str, UserInfo]


auth_file_path = Path('auth.json')
auth_config: UserConfig | None = None
if auth_file_path.exists():
    with open(auth_file_path) as pwd_f:
        auth_file_content = pwd_f.read()
        try:
            auth_config = UserConfig.model_validate(json.loads(auth_file_content))
        except (pydantic.ValidationError, json.JSONDecodeError) as ve:
            logger.warning(f'认证文件不合规, 将忽略: {ve}')
else:
    logger.warning('认证文件未配置, 默认允许所有人进行任何操作')


async def get_current_user(request: fastapi.Request) -> UserInfo | None:
    token = request.cookies.get("auth_token")
    if auth_config is None:
        return UserInfo(username='__DEFAULT_ADMIN__', admin=True, abilities=[])
    if not token:
        return None
    user = auth_config.users.get(token, None)
    if not user:
        return None
    return user


class Authoricator:
    def __init__(
            self,
            required_abilities: list[UserAbilities] | None = None,
    ):
        self.required_abilities = required_abilities

    async def __call__(self, user: UserInfo = fastapi.Depends(get_current_user)) -> UserInfo | None:
        if user is None:
            raise fastapi.HTTPException(status_code=fastapi.status.HTTP_401_UNAUTHORIZED, detail='需要登录, 或用户不存在')
        if user.admin:
            return user
        if self.required_abilities is None:
            return user
        for ability in self.required_abilities:
            if not user.has_ability(ability):
                raise fastapi.HTTPException(status_code=fastapi.status.HTTP_403_FORBIDDEN,
                                            detail=f'当前操作需要权限: {ability}, 用户 {user.username}无该权限')
        return user


PAGE_COUNT = 10


class TaskStatus(BaseModel):
    percent: int | float = 0
    message: Optional[str] = None


# 这里的 task_status 是全局共享的状态
task_status: dict[str, TaskStatus] = {}


if not os.path.exists(archived_document_path):
    os.makedirs(archived_document_path)

if not os.path.exists(thumbnail_folder):
    os.makedirs(thumbnail_folder)


def get_zip_namelist(zip_path: Path) -> str | list[str]:
    if not zip_path.exists():
        return f"{os.listdir(archived_document_path)}"
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        return natsort.natsorted(zip_ref.namelist())


def get_zip_image(zip_path: Path, pic_name: str) -> Optional[io.BytesIO]:
    # 检查 zip 文件是否存在
    if not zip_path.exists():
        return None
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        # 检查图片文件是否存在
        if pic_name not in zip_ref.namelist():
            return None
        # 读取图片文件内容并加载到内存
        with zip_ref.open(pic_name) as img_file:
            # 使用 BytesIO 将文件内容转为内存字节流
            img_data = img_file.read()
            img_bytes = io.BytesIO(img_data)
            return img_bytes


async def get_file_hash(file_path: Path, chunk_size: int = 65536) -> str:
    hash_md5 = hashlib.md5()
    # 必须使用 async with 来打开文件
    async with aiofiles.open(file_path, 'rb') as f:
        while chunk := await f.read(chunk_size):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()


def generate_thumbnail(document_id: int, file_path: Path):
    pic_list = get_zip_namelist(file_path)
    assert isinstance(pic_list, list)
    if not pic_list:
        return

    thumbnail_content = get_zip_image(file_path, pic_list[0])
    if not thumbnail_folder.exists():
        thumbnail_folder.mkdir()
    
    if thumbnail_content is None:
        logger.warning(f'无法生成缩略图，文档 {document_id} 的 ZIP 文件中没有图片')
        return

    with open(thumbnail_folder / Path(f'{document_id}.webp'), "wb") as fu:
        fu.write(thumbnail_content.read())
