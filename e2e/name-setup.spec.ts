import { expect, test } from '@playwright/test';
import { dismissTour, installTestMetaMask, signInWithTestWallet } from './wallet-fixture';
import type { NameClaim } from '../components/setup-state';

// Only name service responses are fixtures. No ENS transaction or live registration is claimed.
for (const width of [1280,320]) test(`name request, receipt-confirmed selection and guide continuation at ${width}px (UI fixtures)`,async({page,context,baseURL})=>{
  await page.setViewportSize({width,height:900});
  const wallet=await installTestMetaMask(context);
  await signInWithTestWallet(page); await dismissTour(page);
  const saved=(await (await context.request.get(`${baseURL}/api/state`)).json()).data;
  const state={...saved,profile:{...saved.profile,displayName:'Fictional UI owner',seeking:'A collaborator',offering:'Design review'}};
  await page.route('**/api/state',route=>route.fulfill({json:{data:state}}));
  let claim:NameClaim|null=null;
  const label='a-long-fictional-networking-identity-for-layout';
  const userName=`${label}.users.example.eth`,agentName=`networking.${userName}`;
  const mutations:string[]=[];
  await page.route('**/api/namespace/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/namespace/claims'&&request.method()==='GET')return route.fulfill({json:{data:{parent:'example.eth',branch:'users.example.eth',issuer:'0x2222222222222222222222222222222222222222',isOperator:false,claim,requests:[],operations:[],custody:'The project controls its parent namespace.',sponsorship:'Issuer pays gas fixture text that must not appear.'}}});
    if(path==='/api/namespace/claim'&&request.method()==='POST'){
      mutations.push(path); expect(request.postDataJSON()).toEqual({label,publicNameAndWalletApproved:true});
      claim={id:'fixture-claim',version:1,label,state:'requested',recipient:wallet.address,userName,agentName,agentConfirmed:false,receipts:[]};
      return route.fulfill({json:{data:{availability:{confirmedAvailable:true}}}});
    }
    throw new Error('Unexpected name service action in a read-only UI fixture.');
  });
  await page.goto('/agent');
  const panel=page.getByRole('region',{name:'Your Meeti name',exact:true});
  await panel.getByLabel('Choose your name',{exact:true}).fill(label);
  await panel.getByRole('checkbox',{name:'I approve this public name and wallet association.',exact:true}).check();
  await panel.getByRole('button',{name:'Request this name',exact:true}).click();
  await expect(panel).toContainText('Your name request is saved.');
  await expect(panel.getByRole('button',{name:'Use this name',exact:true})).toHaveCount(0);
  claim={...claim!,state:'prepared'};
  await panel.getByRole('button',{name:'Check registration',exact:true}).click();
  await expect(panel).toContainText('Review prepared');
  await expect(panel).toContainText('This does not mean a transaction has been sent or confirmed.');
  await expect(panel.getByRole('button',{name:'Use this name',exact:true})).toHaveCount(0);
  claim={...claim,state:'confirmed',receipts:[{operation:'issue-project-subname',hash:`0x${'1'.repeat(64)}`,blockNumber:'1'}]};
  await panel.getByRole('button',{name:'Check registration',exact:true}).click();
  await expect(panel).toContainText('Registration confirmed');
  await expect(panel).toContainText(userName);
  await expect(panel).not.toContainText('Issuer pays gas fixture text');
  await panel.screenshot({path:`artifacts/name-setup-confirmed-${width}.png`});
  await panel.getByRole('button',{name:'Use this name',exact:true}).click();
  await expect(page.getByLabel('Agent ENS name',{exact:true})).toHaveValue(agentName);
  await expect(page.getByLabel('Agent ENS name',{exact:true})).toBeFocused();
  await expect(page.getByRole('button',{name:'Save agent settings',exact:true})).toBeVisible();
  expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  await page.goto('/dashboard');
  await expect(page.getByRole('link',{name:'Set up your agent',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Review setup steps',exact:true}).click();
  const guide=page.getByRole('dialog',{name:'Your connection setup',exact:true});
  await expect(guide).toContainText('Step 6 of 8');
  await guide.getByRole('button',{name:'Use this name',exact:true}).click();
  await expect(guide).toContainText('Step 7 of 8');
  await expect(guide).toContainText(agentName);
  await guide.screenshot({path:`artifacts/name-setup-guide-${width}.png`});
  await expect(guide.getByRole('link',{name:'Open agent setup',exact:true})).toHaveAttribute('href','/agent#name-request');
  await expect(guide).toContainText('Current authority must pass before publication or matching.');
  expect(mutations).toEqual(['/api/namespace/claim']);
  expect(wallet.calls).not.toContain('eth_sendTransaction');
});
