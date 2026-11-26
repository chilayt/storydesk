export const modernIndustrialPack = 'modern_industrial';
export const modernIndustrialRulePath = '00-项目导航/现代工业写作规则.md';

export const sharedDeliveryChecks = ['action_modifier', 'identity_modifier', 'pronoun', 'voice'];
export const historicalDeliveryChecks = [...sharedDeliveryChecks, 'skill_modifier'];
export const modernIndustrialChecks = [...sharedDeliveryChecks, 'industrial_exposition'];
export const deliveryCheckIds = new Set([...historicalDeliveryChecks, ...modernIndustrialChecks]);

export function usesTangWording(rules) {
  if (rules.wordingPolicy !== undefined) return rules.wordingPolicy === 'tang';
  // Older works opted in by putting a specific Tang period in their own rule file.
  return /^(?:唐(?:代|朝)?(?:$|[\s·，（])|架空唐|盛唐|初唐|中唐|晚唐|天宝|开元|贞观)/u.test(rules.historicalPeriod || '');
}

export const modernIndustrialRuleText = `# 现代工业写作规则

只适用启用本卡的作品。具体年代、厂区、工艺、设备和岗位权限以本书设定与本轮资料为准。

1. **动作与线索。** 分句判断动作、观察和人物反应。动作写清谁做了什么、物件或现场发生了什么变化。保留能解释操作、风险、观察或后续决定的细节。删和动作无关的身体或衣着修饰。
2. **身份、指代与声口。** 靠实际判断和做事方式写经验与身份。多人或多台设备在场时，写清谁操作哪一件、谁接到消息。用名字、职务或设备编号消歧。对白贴合说话人的岗位、知识和场合；当面交接、对外说明与私下抱怨各有分寸。
3. **工业信息进入场景。** 优先写角色看到了什么、要作什么决定、决定会造成什么后果。技术说明保留会影响下一步的部分。型号、参数、组织结构和岗位资历须有叙事作用；设备零件、履历或工艺名词避免成串当作人物气质的修饰。缺资料的技术判断标为待核对。
4. **工序、权限与时间。** 核对本场作业发生前已有的前提、现场人员、交接或签字状态。区分提出、批准、执行及复验，区分角色知道的消息和读者知道的事实。前后班次、权限划分和设备状态按本书资料，疑点逐条引原句。
5. **现代用语。** 术语、外文缩写和行业口语按本书年代、岗位与语境使用。读者需要理解时用上下文讲清含义。时代、专业用法或制度存疑时留待核对，以本书作者裁定为准。
`;
