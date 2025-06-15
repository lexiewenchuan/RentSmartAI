export type City = {
  code: string;     // 贝壳子域名前缀
  name: string;     // 城市名
  pinyin: string;   // 拼音（搜索用）
  hot?: boolean;    // 热门城市
};

export const CITIES: City[] = [
  // 热门城市
  { code: 'bj', name: '北京', pinyin: 'beijing', hot: true },
  { code: 'sh', name: '上海', pinyin: 'shanghai', hot: true },
  { code: 'gz', name: '广州', pinyin: 'guangzhou', hot: true },
  { code: 'sz', name: '深圳', pinyin: 'shenzhen', hot: true },
  { code: 'wh', name: '武汉', pinyin: 'wuhan', hot: true },
  { code: 'cd', name: '成都', pinyin: 'chengdu', hot: true },
  { code: 'hz', name: '杭州', pinyin: 'hangzhou', hot: true },
  { code: 'nj', name: '南京', pinyin: 'nanjing', hot: true },
  { code: 'xa', name: '西安', pinyin: 'xian', hot: true },
  { code: 'tj', name: '天津', pinyin: 'tianjin', hot: true },
  { code: 'cq', name: '重庆', pinyin: 'chongqing', hot: true },
  { code: 'su', name: '苏州', pinyin: 'suzhou', hot: true },

  // 其他城市
  { code: 'cs', name: '长沙', pinyin: 'changsha' },
  { code: 'qd', name: '青岛', pinyin: 'qingdao' },
  { code: 'nb', name: '宁波', pinyin: 'ningbo' },
  { code: 'km', name: '昆明', pinyin: 'kunming' },
  { code: 'hf', name: '合肥', pinyin: 'hefei' },
  { code: 'jn', name: '济南', pinyin: 'jinan' },
  { code: 'sy', name: '沈阳', pinyin: 'shenyang' },
  { code: 'dl', name: '大连', pinyin: 'dalian' },
  { code: 'fz', name: '福州', pinyin: 'fuzhou' },
  { code: 'xm', name: '厦门', pinyin: 'xiamen' },
  { code: 'zz', name: '郑州', pinyin: 'zhengzhou' },
  { code: 'wx', name: '无锡', pinyin: 'wuxi' },
  { code: 'cc', name: '长春', pinyin: 'changchun' },
  { code: 'nc', name: '南昌', pinyin: 'nanchang' },
  { code: 'nn', name: '南宁', pinyin: 'nanning' },
  { code: 'gy', name: '贵阳', pinyin: 'guiyang' },
  { code: 'hrb', name: '哈尔滨', pinyin: 'haerbin' },
  { code: 'sjz', name: '石家庄', pinyin: 'shijiazhuang' },
  { code: 'ty', name: '太原', pinyin: 'taiyuan' },
  { code: 'dg', name: '东莞', pinyin: 'dongguan' },
  { code: 'fs', name: '佛山', pinyin: 'foshan' },
  { code: 'hk', name: '海口', pinyin: 'haikou' },
  { code: 'hui', name: '惠州', pinyin: 'huizhou' },
  { code: 'lz', name: '兰州', pinyin: 'lanzhou' },
  { code: 'zs', name: '中山', pinyin: 'zhongshan' },
  { code: 'zh', name: '珠海', pinyin: 'zhuhai' },
  { code: 'nt', name: '南通', pinyin: 'nantong' },
  { code: 'wz', name: '温州', pinyin: 'wenzhou' },
  { code: 'yz', name: '扬州', pinyin: 'yangzhou' },
];

export const HOT_CITIES = CITIES.filter(c => c.hot);

export function searchCities(keyword: string): City[] {
  if (!keyword.trim()) return [];
  const kw = keyword.toLowerCase().trim();
  return CITIES.filter(c =>
    c.name.includes(kw) || c.pinyin.includes(kw) || c.code.includes(kw)
  );
}
