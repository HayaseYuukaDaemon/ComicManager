PRAGMA foreign_keys = ON;


-- 对应 GenericTag
CREATE TABLE tags (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    tag_group   TEXT NOT NULL,

    UNIQUE (tag_group, name),

    CHECK (length(trim(name)) > 0),
    CHECK (length(trim(tag_group)) > 0)
);


-- 对应 SpecificTagMetaUnion
--
-- 公共且用于查询、关联、唯一性判断的字段单独保存；
-- 不稳定的站点特有字段统一保存在 meta_json 中。
-- tag_ptr 提供了一个外部约束, 只要还有一个 tag_ptr 指向某个 GenericTag, 那么这个 GenericTag 就不能被删除。
CREATE TABLE specific_tags (
    id              INTEGER PRIMARY KEY,
    -- 指向且只能指向一个 GenericTag
    generic_tag_id  INTEGER NOT NULL,

    -- 稳定的类型判别字段，例如：
    -- hitomi.la
    -- nhentai.net
    site            TEXT NOT NULL,

    -- SpecificTag 公共字段
    origin_name     TEXT NOT NULL,
    origin_group    TEXT NOT NULL,

    -- 只保存站点特有字段，例如：
    -- {"url": "/character/xxx.html", "tag_sex": "female"}
    --
    -- 不应再次保存 site、origin_name、origin_group，
    -- 避免同一数据出现两个互相冲突的来源。
    -- 所以只要origin_name和meta_json作为一个整体作为唯一键就可以
    -- 因此meta_json必须是canicolate的
    meta_json       TEXT NOT NULL,

    FOREIGN KEY (generic_tag_id)
        REFERENCES tags(id)
        ON DELETE CASCADE,

    CHECK (length(trim(site)) > 0),
    CHECK (length(trim(origin_name)) > 0),

    CHECK (
        origin_group IS NULL
        OR length(trim(origin_group)) > 0
    ),

    CHECK (
        json_valid(meta_json)
        AND json_type(meta_json) = 'object'
    )
);


-- 一个来源站点中的一个标签只能映射到一个 GenericTag。
--
-- origin_group 是可空字段，而 SQLite 的 UNIQUE 允许存在多个 NULL，
-- 因此通过 COALESCE 将 NULL 统一用于唯一性判断。
CREATE UNIQUE INDEX uq_specific_tags_identity
ON specific_tags (
    site,
    COALESCE(origin_group, ''),
    origin_name
);


-- 查询某个 GenericTag 对应的全部 specific metas。
CREATE INDEX idx_specific_tag_metas_tag_id
ON specific_tag_metas (tag_id);


-- comic_tags 表直接存储站点特定 tag , 需要归一化的 tag 的时候可以实时计算, 这样还能保留所有原有的站点特定 tag 信息, 方便后续分析和处理
CREATE TABLE comic_tags (
    comic_id    INTEGER NOT NULL,
    specific_tag_id      INTEGER NOT NULL,

    PRIMARY KEY (comic_id, specific_tag_id),

    FOREIGN KEY (comic_id)
        REFERENCES comics(id)
        ON DELETE CASCADE,

    FOREIGN KEY (specific_tag_id)
        REFERENCES specific_tags(id)
        ON DELETE CASCADE
)