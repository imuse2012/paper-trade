import singleton from '../common/singleton'
import sqlstr from '../common/sqlStr'
const { mainDB, redisClient, jpushClient } = singleton
export default async({ Id, Commission, delta, AccountNo, OrdType, Side, OrderQty, Price, SecuritiesType, SecuritiesNo, MemberCode }) => {
    let transaction = await mainDB.transaction();
    try {
        let [account] = await mainDB.query("select * from wf_street_practice_account where AccountNo=:AccountNo", { replacements: { AccountNo } })
        let Cash = account[0].Cash
        if (Cash + delta < 0) {
            throw 1
        }
        await mainDB.query(...sqlstr.update2("wf_street_practice_account", { Cash: Cash + delta }, null, { AccountNo }, { transaction }))
        let [postions] = await mainDB.query("select * from wf_street_practice_positions  where AccountNo=:AccountNo and SecuritiesType=:SecuritiesType and SecuritiesNo=:SecuritiesNo", { replacements: { AccountNo, SecuritiesType, SecuritiesNo } })
        let Positions = postions.length ? postions[0].Positions : 0
        if (Side == "S") {
            Positions -= OrderQty
            if (Positions > 0)
                await mainDB.query(...sqlstr.update2("wf_street_practice_positions", { Positions }, null, { AccountNo, SecuritiesType, SecuritiesNo }, { transaction }))
            else if (Positions == 0) await mainDB.query("delete from wf_street_practice_positions where AccountNo=:AccountNo and SecuritiesType=:SecuritiesType and SecuritiesNo=:SecuritiesNo", { replacements: { AccountNo, SecuritiesType, SecuritiesNo }, transaction: t })
            else {
                throw 2
            }
        } else {
            if (Positions) {
                Positions += OrderQty
                await mainDB.query(...sqlstr.update2("wf_street_practice_positions", { Positions }, null, { AccountNo, SecuritiesType, SecuritiesNo }, { transaction }))
            } else {
                await mainDB.query(...sqlstr.insert2("wf_street_practice_positions", { Positions: OrderQty, SecuritiesType, SecuritiesNo, MemberCode, AccountNo }, { CreateTime: "now()" }, { transaction }))
            }
        }
        await mainDB.query(...sqlstr.update2("wf_street_practice_order", { execType: 1, Commission, Price }, { TurnoverTime: "now()" }, { Id }, { transaction }))
        await transaction.commit()
        return 0
    } catch (ex) {
        await transaction.rollback()
        switch (ex) {
            case 1:
            case 2:
                await mainDB.query(...sqlstr.update2("wf_street_practice_order", { execType: 3, Reason: ex }, null, { Id }, { transaction }))
                return 0
            default:
                return ex
        }
        return ex
    }
}