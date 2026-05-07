BEGIN;

-- ---------------------------------------------------------------------------
-- Integration test seed data (PostgreSQL)
-- ---------------------------------------------------------------------------
-- Covers:
--   users, store, bread, inventory, tag, inventory_tag
-- Includes:
--   - multiple stations (강남역, 대전역, 홍대입구역, 잠실역)
--   - diverse breads and tags
--   - enough inventory for hold/reservation success + out-of-stock scenarios
-- ---------------------------------------------------------------------------

-- Reset related tables in FK-safe order.
TRUNCATE TABLE
  reservation_item,
  reservation,
  inventory_tag,
  inventory,
  tag,
  bread,
  store,
  users
RESTART IDENTITY CASCADE;

-- 1) users
INSERT INTO users (id, name, created_at) VALUES
  (1, '테스트유저1', NOW()),
  (2, '테스트유저2', NOW()),
  (3, '테스트유저3', NOW()),
  (4, '관리자', NOW());

-- 2) store (with business hours)
INSERT INTO store (id, name, station, address, open_time, close_time, created_at) VALUES
  (1, '하레하레 강남',   '강남역',     '서울 강남구 강남대로 100', '09:00', '22:00', NOW()),
  (2, '성심당 본점',     '대전역',     '대전 중구 중앙로 123',     '08:00', '21:00', NOW()),
  (3, '소금빵연구소',    '홍대입구역', '서울 마포구 양화로 50',    '10:00', '23:00', NOW()),
  (4, '브레드워크 잠실', '잠실역',     '서울 송파구 올림픽로 300', '07:30', '20:30', NOW());

-- 3) bread
INSERT INTO bread (id, name, created_at) VALUES
  (1, '소금빵', NOW()),
  (2, '고구마빵', NOW()),
  (3, '크루아상', NOW()),
  (4, '단팥빵', NOW()),
  (5, '치아바타', NOW()),
  (6, '마늘바게트', NOW()),
  (7, '잠봉뵈르', NOW()),
  (8, '통밀식빵', NOW());

-- 4) tag (preference)
INSERT INTO tag (id, name) VALUES
  (1, '짭짤'),
  (2, '담백'),
  (3, '달콤'),
  (4, '고소'),
  (5, '바삭'),
  (6, '부드러움'),
  (7, '든든함'),
  (8, '마늘향');

-- 5) inventory
-- NOTE:
--   - store_id=1, bread_id=1 has available=12: hold/reservation success case
--   - store_id=1, bread_id=2 has available=1 : out-of-stock case for qty>=2
--   - store_id=2, bread_id=1 has available=0 : immediate out-of-stock case
INSERT INTO inventory (id, store_id, bread_id, price, available, created_at, updated_at) VALUES
  (1,  1, 1, 3200, 12, NOW(), NOW()), -- 하레하레 강남 / 소금빵
  (2,  1, 2, 3500,  1, NOW(), NOW()), -- 하레하레 강남 / 고구마빵 (부족)
  (3,  1, 3, 3800,  8, NOW(), NOW()), -- 하레하레 강남 / 크루아상
  (4,  1, 7, 6500,  5, NOW(), NOW()), -- 하레하레 강남 / 잠봉뵈르

  (5,  2, 1, 3000,  0, NOW(), NOW()), -- 성심당 본점 / 소금빵 (품절)
  (6,  2, 4, 2500, 15, NOW(), NOW()), -- 성심당 본점 / 단팥빵
  (7,  2, 6, 4200,  9, NOW(), NOW()), -- 성심당 본점 / 마늘바게트

  (8,  3, 1, 3400,  6, NOW(), NOW()), -- 소금빵연구소 / 소금빵
  (9,  3, 5, 3900, 11, NOW(), NOW()), -- 소금빵연구소 / 치아바타
  (10, 3, 8, 5200,  4, NOW(), NOW()), -- 소금빵연구소 / 통밀식빵

  (11, 4, 3, 3600, 10, NOW(), NOW()), -- 브레드워크 잠실 / 크루아상
  (12, 4, 4, 2400, 14, NOW(), NOW()), -- 브레드워크 잠실 / 단팥빵
  (13, 4, 6, 4100,  2, NOW(), NOW()); -- 브레드워크 잠실 / 마늘바게트

-- 6) inventory_tag (many-to-many)
INSERT INTO inventory_tag (inventory_id, tag_id) VALUES
  -- inventory 1: 소금빵 (짭짤, 바삭)
  (1, 1), (1, 5),
  -- inventory 2: 고구마빵 (달콤, 부드러움)
  (2, 3), (2, 6),
  -- inventory 3: 크루아상 (고소, 바삭)
  (3, 4), (3, 5),
  -- inventory 4: 잠봉뵈르 (짭짤, 든든함)
  (4, 1), (4, 7),

  -- inventory 5: 소금빵 품절 (짭짤)
  (5, 1),
  -- inventory 6: 단팥빵 (달콤, 부드러움)
  (6, 3), (6, 6),
  -- inventory 7: 마늘바게트 (짭짤, 마늘향, 바삭)
  (7, 1), (7, 8), (7, 5),

  -- inventory 8: 소금빵 (짭짤, 담백)
  (8, 1), (8, 2),
  -- inventory 9: 치아바타 (담백, 고소)
  (9, 2), (9, 4),
  -- inventory 10: 통밀식빵 (담백, 든든함)
  (10, 2), (10, 7),

  -- inventory 11: 크루아상 (고소, 바삭)
  (11, 4), (11, 5),
  -- inventory 12: 단팥빵 (달콤)
  (12, 3),
  -- inventory 13: 마늘바게트 (마늘향, 바삭)
  (13, 8), (13, 5);

COMMIT;
