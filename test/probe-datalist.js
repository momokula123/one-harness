// 探针：验证设置里的模型下拉（openSelect 自定义下拉，替代已删除的原生 datalist）。
// 覆盖：常规段点输入框/▾ 弹清单、点选回填、真拉取后清单跟着端点走、
//       兜底卡片按自己拉的清单弹。
// 用法： node test/run-ui.js test/probe-datalist.js
(async () => {
  const $id = (i) => document.getElementById(i);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const check = (name, cond, extra) => {
    console.log('[probe] ' + (cond ? 'ok   ' : 'FAIL ') + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
    if (!cond) fails.push(name);
  };
  const openPop = () => document.querySelector('.sel-pop:not(.hidden)');
  const popItems = () => { const p = openPop(); return p ? [...p.querySelectorAll('.sel-item')].map((el) => el.dataset.v) : null; };

  let simPick = null, afterReal = null, fbResult = null;

  try {
    // ① 打开设置，确保在「常规」
    $id('btn-open-settings').click();
    await wait(600);
    const secBtn = document.querySelector('#settings-nav .item[data-sec="general"]');
    if (secBtn) { secBtn.click(); await wait(400); }
    check('P1 常规段有模型输入框和 ▾ 触发', !!$id('set-model') && !!$id('set-model-pick'));

    // ② 模拟拉取成功后的清单（openSelect 每次现读 S.models，不用重渲染）
    S.models = ['probe-alpha', 'probe-beta', 'probe-gamma'];
    $id('set-model').click();
    await wait(200);
    check('P2 点模型输入框弹出自定义下拉，清单与 S.models 一致',
      JSON.stringify(popItems()) === JSON.stringify(['probe-alpha', 'probe-beta', 'probe-gamma']), popItems());
    // 点选第二项 → 回填输入框
    const items = openPop() ? [...openPop().querySelectorAll('.sel-item')] : [];
    if (items[1]) { items[1].click(); await wait(200); }
    simPick = $id('set-model').value;
    check('P3 点选清单项后回填输入框', simPick === 'probe-beta', simPick);

    // ④ 真点「拉取模型列表」（桩端点返回 ['stub-model']），再点框看清单
    $id('btn-test').click();
    await wait(4000);
    $id('set-model').click();
    await wait(200);
    afterReal = popItems();
    check('P4 真拉取后下拉与端点返回一致', JSON.stringify(afterReal) === JSON.stringify(['stub-model']), afterReal);
    document.body.click(); // 收起下拉
    await wait(150);

    // ⑤ 兜底卡片：没拉取时点框提示先拉取；塞入卡片自己的清单后点框弹的是那份
    const fbBtn = document.querySelector('#settings-nav .item[data-sec="fallback"]');
    if (fbBtn) {
      fbBtn.click();
      await wait(400);
      check('P5 兜底卡片有拉取按钮和 ▾ 触发', !!$id('fb-llm-fetch') && !!$id('fb-llm-pick') && !!$id('fb-llm-model'));
      S.fbModels = { llm: ['fb-alpha', 'fb-beta'] };
      $id('fb-llm-model').click();
      await wait(200);
      const fbItems = popItems();
      check('P6 兜底模型框弹出的是这张卡自己拉的清单',
        JSON.stringify(fbItems) === JSON.stringify(['fb-alpha', 'fb-beta']), fbItems);
      const fbEls = openPop() ? [...openPop().querySelectorAll('.sel-item')] : [];
      if (fbEls[0]) { fbEls[0].click(); await wait(200); }
      fbResult = $id('fb-llm-model').value;
      check('P7 兜底点选后回填', fbResult === 'fb-alpha', fbResult);
    } else {
      console.log('[probe] fallback 段按钮不存在，跳过 P5-P7');
    }
  } catch (e) {
    check('P0 探针本身没炸', false, e.message);
  }
  return { fails, simPick, afterReal, fbResult };
})();
