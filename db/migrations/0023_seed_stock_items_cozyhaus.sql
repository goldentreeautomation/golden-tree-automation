-- 0023_seed_stock_items_cozyhaus.sql — CozyHaus 디저트 재고 품목 시딩 (오너 요청, 2026-09-06)
--
-- 오너가 올린 Square 카탈로그 엑셀(MLD7Z70BJ49EP_catalog-2026-09-07-0110.xlsx)의 디저트
-- 카테고리(Dessert/Bread, Cake, Basque Cheesecake 등) 50개 품목을 시딩한다.
-- 마카롱/쿠키의 "Regular" variation은 실제 맛이 아니라 계산대에서 맛 선택 안 한 경우의
-- 캐치올이라 제외(0013에서 발견한 문제와 동일 — Square 판매 데이터의 78%/63%가 여기 찍힘).
--
-- units_per_container는 전부 1로 시딩 — 실제 값(한 통에 몇 개)은 오너가 나중에 알려주면
-- 웹페이지에서 직접 수정한다. 소분해서 파는 게 아니라 낱개로 세는 케이크류는 container_label='개'.

insert into public.stock_items (name, location_id, square_item_name, square_variation_name, units_per_container, container_label)
values
  ('Cookie - Lemon Earl Grey', 'L7DA0MBKD2X4P', 'Cookie', 'Lemon Earl Grey', 1, '통'),
  ('Cookie - Oreo S''more', 'L7DA0MBKD2X4P', 'Cookie', 'Oreo S''more', 1, '통'),
  ('Cookie - Lotus S''more', 'L7DA0MBKD2X4P', 'Cookie', 'Lotus S''more', 1, '통'),
  ('Cookie - Chocolate Chip', 'L7DA0MBKD2X4P', 'Cookie', 'Chocolate Chip', 1, '통'),
  ('Cookie - Peanut Butter Caramel', 'L7DA0MBKD2X4P', 'Cookie', 'Peanut Butter Caramel', 1, '통'),
  ('Cookie Puff - Plain', 'L7DA0MBKD2X4P', 'Cookie Puff', 'Plain', 1, '통'),
  ('Cookie Puff - Oreo', 'L7DA0MBKD2X4P', 'Cookie Puff', 'Oreo', 1, '통'),
  ('Cookie Puff - Strawberry', 'L7DA0MBKD2X4P', 'Cookie Puff', 'Strawberry', 1, '통'),
  ('Dubai Cookie - Regular', 'L7DA0MBKD2X4P', 'Dubai Cookie', 'Regular', 1, '통'),
  ('Egg Tart - Regular', 'L7DA0MBKD2X4P', 'Egg Tart', 'Regular', 1, '통'),
  ('Fresh Strawberry Cake - 7 inch (~10 ppl)', 'L7DA0MBKD2X4P', 'Fresh Strawberry Cake', '7 inch (~10 ppl)', 1, '개'),
  ('Macaron - Pistachio', 'L7DA0MBKD2X4P', 'Macaron', 'Pistachio', 1, '통'),
  ('Macaron - Creme Brulee', 'L7DA0MBKD2X4P', 'Macaron', 'Creme Brulee', 1, '통'),
  ('Macaron - Strawberry Crunch', 'L7DA0MBKD2X4P', 'Macaron', 'Strawberry Crunch', 1, '통'),
  ('Macaron - Truffle Choco', 'L7DA0MBKD2X4P', 'Macaron', 'Truffle Choco', 1, '통'),
  ('Macaron - Ferrero Rocher', 'L7DA0MBKD2X4P', 'Macaron', 'Ferrero Rocher', 1, '통'),
  ('Macaron - French Vanilla', 'L7DA0MBKD2X4P', 'Macaron', 'French Vanilla', 1, '통'),
  ('Macaron - Chocolate', 'L7DA0MBKD2X4P', 'Macaron', 'Chocolate', 1, '통'),
  ('Macaron - Nutella Cream Cheese', 'L7DA0MBKD2X4P', 'Macaron', 'Nutella Cream Cheese', 1, '통'),
  ('Macaron - Blueberry Cream Cheese', 'L7DA0MBKD2X4P', 'Macaron', 'Blueberry Cream Cheese', 1, '통'),
  ('Macaron - Raspberry Cream Cheese', 'L7DA0MBKD2X4P', 'Macaron', 'Raspberry Cream Cheese', 1, '통'),
  ('Macaron - Matcha', 'L7DA0MBKD2X4P', 'Macaron', 'Matcha', 1, '통'),
  ('Macaron - Coffee', 'L7DA0MBKD2X4P', 'Macaron', 'Coffee', 1, '통'),
  ('Macaron - Salted Caramel', 'L7DA0MBKD2X4P', 'Macaron', 'Salted Caramel', 1, '통'),
  ('Macaron - Oreo', 'L7DA0MBKD2X4P', 'Macaron', 'Oreo', 1, '통'),
  ('Maple Apple Cake - 7 inch (~10 ppl)', 'L7DA0MBKD2X4P', 'Maple Apple Cake', '7 inch (~10 ppl)', 1, '개'),
  ('Matilda Cake - 7 inch (~10 ppl)', 'L7DA0MBKD2X4P', 'Matilda Cake', '7 inch (~10 ppl)', 1, '개'),
  ('Pistachio Raspberry Cheesecake (GF) - 7 inch (~10 ppl)', 'L7DA0MBKD2X4P', 'Pistachio Raspberry Cheesecake (GF)', '7 inch (~10 ppl)', 1, '개'),
  ('Plain Basque Cheesecake (GF) - 7 inch (~10 ppl)', 'L7DA0MBKD2X4P', 'Plain Basque Cheesecake (GF)', '7 inch (~10 ppl)', 1, '개'),
  ('Scrolls - Cinnamon', 'L7DA0MBKD2X4P', 'Scrolls', 'Cinnamon', 1, '통'),
  ('Scrolls - Almond scroll', 'L7DA0MBKD2X4P', 'Scrolls', 'Almond scroll', 1, '통'),
  ('Scrolls - Apple Cinnamon scroll', 'L7DA0MBKD2X4P', 'Scrolls', 'Apple Cinnamon scroll', 1, '통'),
  ('Scrolls - Lotus', 'L7DA0MBKD2X4P', 'Scrolls', 'Lotus', 1, '통'),
  ('Scrolls - Strawberry Peanut Butter', 'L7DA0MBKD2X4P', 'Scrolls', 'Strawberry Peanut Butter', 1, '통'),
  ('Scrolls - Pecan Caramel', 'L7DA0MBKD2X4P', 'Scrolls', 'Pecan Caramel', 1, '통'),
  ('Scrolls - Banoffee Pie Scroll', 'L7DA0MBKD2X4P', 'Scrolls', 'Banoffee Pie Scroll', 1, '통'),
  ('Scrolls - Blueberry scroll', 'L7DA0MBKD2X4P', 'Scrolls', 'Blueberry scroll', 1, '통'),
  ('Scrolls - Garlic Cheese Scroll', 'L7DA0MBKD2X4P', 'Scrolls', 'Garlic Cheese Scroll', 1, '통'),
  ('Scrolls - Pistachio Scroll', 'L7DA0MBKD2X4P', 'Scrolls', 'Pistachio Scroll', 1, '통'),
  ('Sliced Cake - Tiramisu Cup', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Tiramisu Cup', 1, '개'),
  ('Sliced Cake - Mango Tiramisu Cup', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Mango Tiramisu Cup', 1, '개'),
  ('Sliced Cake - Strawberry Tiramisu Cup', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Strawberry Tiramisu Cup', 1, '개'),
  ('Sliced Cake - Pistachio Raspberry Tiramisu Cup', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Pistachio Raspberry Tiramisu Cup', 1, '개'),
  ('Sliced Cake - Pistachio Raspberry', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Pistachio Raspberry', 1, '개'),
  ('Sliced Cake - Strawberry Tiramisu', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Strawberry Tiramisu', 1, '개'),
  ('Sliced Cake - Coffee Tiramisu', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Coffee Tiramisu', 1, '개'),
  ('Sliced Cake - Mango Tiramisu', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Mango Tiramisu', 1, '개'),
  ('Sliced Cake - Matilda Cake', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Matilda Cake', 1, '개'),
  ('Sliced Cake - Maple Apple Cinnamon Cake', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Maple Apple Cinnamon Cake', 1, '개'),
  ('Sliced Cake - Fresh Strawberry Cake', 'L7DA0MBKD2X4P', 'Sliced Cake', 'Fresh Strawberry Cake', 1, '개')
on conflict (location_id, name) do nothing;
