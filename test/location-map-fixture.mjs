import { LOCATION_MAP_INDEX } from '../core/location-maps.mjs';

export const mapBody = '<!doctype html><title>验收用地图</title><p>MAP_BYTES_MUST_STAY_LOCAL</p>';
const entries = [
  ['city', '白沙城', '白沙西门', '全城图', 'v3', '城图', '从西门出城。'],
  ['residence', '方家本宅', '方宅', '本宅图', 'v3.00', '宅图', '从前院经中堂进寝门。'],
  ['estate', '方家田庄', '西田庄', '二维动态图', 'v1', '田庄图', '出白沙西门向西十里到庄门。']
];
export const mapConfig = {
  version: 1, historicalPaths: ['04-空间/方宅旧规制.md'],
  places: entries.map(([id, name, alias, title, version, file, route]) => ({
    id, name, aliases: [alias], summary: '查询' + name + '的动线',
    map: { title, version, path: '04-空间/' + file + '.html' },
    sources: [{ title: name + '动线原档', path: '04-空间/' + file + '设定.md', status: '同版图面说明', anchors: [route] }]
  }))
};

export async function seedLocationMaps(fixture) {
  await fixture.write(LOCATION_MAP_INDEX, JSON.stringify(mapConfig));
  for (const place of mapConfig.places) {
    await fixture.write(place.map.path, mapBody);
    const source = place.sources[0];
    await fixture.write(source.path, '# ' + source.title + '\n\n' + source.anchors[0] + '\n\n未选择的旧地物说明。\n');
  }
  await fixture.write('04-空间/方宅旧规制.md', '# 方宅旧规制\n\n早版采用不同走法。');
}
