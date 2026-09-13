import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ProfileSettings } from "../src/screens/ProfileSettings";
import { createProfileApi } from "../src/api";

it("submits cleared personal fields alongside the name through the profile API", async () => {
  const profile = {displayName:"テスト",addressingStyle:"san" as const,occupation:"企画",region:"東京",updatedAt:"2026-09-07T00:00:00.000Z"};
  let sent: unknown;
  const api = createProfileApi(async (_url,init) => {
    sent=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({profile:{...profile,...sent as object}}),{status:200});
  });
  const save=vi.fn((input)=>api.save(input));
  render(<ProfileSettings profile={profile} personalDetails={profile} saving={false} error={null} onSave={save} onClose={()=>{}} onOpenMemories={()=>{}} />);
  const user=userEvent.setup();
  await user.clear(screen.getByLabelText("職業（任意）"));
  await user.clear(screen.getByLabelText("住んでいる地域（任意）"));
  await user.type(screen.getByLabelText("住んでいる地域（任意）"),"京都");
  await user.click(screen.getByRole("button",{name:"保存する"}));
  expect(sent).toEqual({displayName:"テスト",addressingStyle:"san",occupation:"",region:"京都"});
  expect(await save.mock.results[0].value).toMatchObject({occupation:"",region:"京都"});
});
