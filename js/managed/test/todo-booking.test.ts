import {describe,expect,it} from "vitest";
import {extractTodoBooking,bookingProposal} from "../src/todo-booking";
import type {TodoMailSuggestionAI} from "../src/todo-mail-suggest";
const booking={property:"Pine Hotel",property_quote:"Pine Hotel",location:"Pine Village, Greece",check_in:"2090-12-20",check_out:"2090-12-22",check_in_quote:"December 20, 2090",check_out_quote:"December 22, 2090"};
const evidence=[{kind:"email" as const,reference:"gmail:example",detail:"Confirmation",content:JSON.stringify({body:"Pine Hotel. Pine Village. Country: Greece. Check-in December 20, 2090. Check-out December 22, 2090."})}];
const model=(value:typeof booking)=>({run:async()=>({response:JSON.stringify(value)})}) as TodoMailSuggestionAI;
describe("grounded booking location",()=>{
 it("discards an inferred optional address while preserving verified property and dates",async()=>{
  const result=await extractTodoBooking(model(booking),evidence);
  expect(result.location).toBe("");
  expect(bookingProposal(result,{events:[],partial:false,errors:[],calendars_checked:1}).proposal).toContain("Location: Pine Hotel");
 });
 it("still blocks invented properties and mismatched date evidence",async()=>{
  await expect(extractTodoBooking(model({...booking,property:"Other Hotel",property_quote:"Other Hotel"}),evidence)).rejects.toThrow("incomplete_booking_evidence");
  await expect(extractTodoBooking(model({...booking,check_in:"2090-12-19"}),evidence)).rejects.toThrow("incomplete_booking_evidence");
 });
 it("retains an exactly grounded optional location",async()=>{
  expect((await extractTodoBooking(model({...booking,location:"Pine Village"}),evidence)).location).toBe("Pine Village");
 });
});
